/**
 * LANShare signaling server.
 *
 * Responsibilities (spec §24):
 *   1. accept WebSocket connections
 *   2. assign temporary peer ids
 *   3. track online peers / room membership
 *   4. forward WebRTC signaling (offer / answer / ICE)
 *   5. handle disconnects and stale peers
 *   6. never store transferred file contents
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { existsSync, readFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import { RoomManager, type PeerRecord } from './rooms.js';
import {
  ClientMessageSchema,
  type ClientMessage,
  type PeerInfo,
  type ServerMessage,
} from './protocol.js';
import { buildIceServers, matchOrigin, serverConfig } from './config.js';
import { log } from './logger.js';
import { serveStatic } from './static.js';
import { joinUrls } from './lan.js';

export interface SignalingServerOptions {
  port?: number;
  host?: string;
  /** 0 disables the origin allow-list. */
  allowedOrigins?: string[];
  maxPeersPerRoom?: number;
  maxRooms?: number;
  roomTtlMs?: number;
  maxMessageBytes?: number;
  rateLimitPerSecond?: number;
  rateLimitBurst?: number;
  heartbeatIntervalMs?: number;
  helloTimeoutMs?: number;
  maxInvalidMessages?: number;
  /** Set false to disable timers (tests drive the clock manually). */
  timers?: boolean;
  /** Serve the built frontend from this process (offline LAN mode). */
  serveStatic?: boolean;
  staticRoot?: string;
  /** Absolute path of the single-file offline app to offer at /LANShare.html. */
  singleFilePath?: string;
  /** Advertise no external ICE servers: the LAN is the only network there is. */
  offlineMode?: boolean;
  /** TLS material; when present the HTTP server is an HTTPS server. */
  tls?: { cert: string; key: string };
}

export interface SignalingServer {
  httpServer: HttpServer;
  wss: WebSocketServer;
  manager: RoomManager;
  listen(): Promise<number>;
  close(): Promise<void>;
  /** Exposed for tests: current room ids. */
  stats(): ReturnType<RoomManager['stats']>;
}

interface TokenBucket {
  tokens: number;
  last: number;
}

interface ConnectionState {
  peerId: string | null;
  greeted: boolean;
  invalid: number;
  bucket: TokenBucket;
  helloDeadline: NodeJS.Timeout | null;
  lastPong: number;
}

export function createSignalingServer(options: SignalingServerOptions = {}): SignalingServer {
  const maxMessageBytes = options.maxMessageBytes ?? serverConfig.maxMessageBytes;
  const helloTimeoutMs = options.helloTimeoutMs ?? serverConfig.helloTimeoutMs;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? serverConfig.heartbeatIntervalMs;
  const maxInvalid = options.maxInvalidMessages ?? serverConfig.maxInvalidMessages;
  const ratePerSecond = options.rateLimitPerSecond ?? serverConfig.rateLimitPerSecond;
  const rateBurst = options.rateLimitBurst ?? serverConfig.rateLimitBurst;
  const allowedOrigins = options.allowedOrigins ?? serverConfig.allowedOrigins;
  const serveFrontend = options.serveStatic ?? serverConfig.serveStatic;
  const staticRoot = options.staticRoot ?? serverConfig.staticRoot;
  const singleFilePath = (options.singleFilePath ?? serverConfig.singleFilePath).trim();
  const offlineMode = options.offlineMode ?? serverConfig.offlineMode;

  const manager = new RoomManager({
    maxPeersPerRoom: options.maxPeersPerRoom ?? serverConfig.maxPeersPerRoom,
    maxRooms: options.maxRooms ?? serverConfig.maxRooms,
    roomTtlMs: options.roomTtlMs ?? serverConfig.roomTtlMs,
  });

  const requestHandler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    // The single-file app: one HTML document that needs no server, offered here so a phone
    // can save it while it is connected and use it later without any server at all.
    if ((url.pathname === '/LANShare.html' || url.pathname === '/lanshare.html') && singleFilePath) {
      if (existsSync(singleFilePath)) {
        const body = readFileSync(singleFilePath);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': String(body.length),
          'content-disposition': 'attachment; filename="LANShare.html"',
          'cache-control': 'no-store',
          'access-control-allow-origin': '*',
        });
        res.end(req.method === 'HEAD' ? undefined : body);
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('The single-file build is not available. Run `npm run build:single`.');
      return;
    }

    // A tiny presence check so the UI only offers the download when it exists.
    if (url.pathname === '/single-file.json') {
      const available = Boolean(singleFilePath) && existsSync(singleFilePath);
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ available, path: available ? '/LANShare.html' : null }));
      return;
    }

    if (url.pathname === '/health') {
      const stats = manager.stats();
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          status: 'ok',
          version: serverConfig.version,
          rooms: stats.rooms,
          peers: stats.peers,
          uptimeMs: stats.uptimeMs,
          maxPeersPerRoom: options.maxPeersPerRoom ?? serverConfig.maxPeersPerRoom,
        }),
      );
      return;
    }
    // When this process is also the web host (offline mode) the frontend owns the document
    // routes; the JSON blurb below is only the answer when there is no frontend to serve.
    const isDocumentRequest = req.method === 'GET' || req.method === 'HEAD';
    if (serveFrontend && isDocumentRequest && url.pathname !== '/ws' && serveStatic({ root: staticRoot }, req, res)) {
      return;
    }
    if (url.pathname === '/' || url.pathname === '/ws') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(
        JSON.stringify({
          service: 'LANShare signaling server',
          author: 'Muhammad Anas',
          usage: 'Connect over WebSocket to this path (default /ws). Signaling only — file data never passes through here.',
          health: '/health',
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  };

  // `createServer` (HTTP) and `createServer(tls)… ` are identical apart from the transport,
  // so HTTPS is a flag rather than a second server implementation.
  const httpServer = options.tls
    ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, requestHandler)
    : createServer(requestHandler);

  const wss = new WebSocketServer({
    server: httpServer,
    path: '/ws',
    maxPayload: maxMessageBytes,
    perMessageDeflate: false, // SDP is small; compression costs CPU and enables zip-bomb style abuse
    /**
     * Origin allow-list, enforced *before* the WebSocket handshake completes: a page on a
     * disallowed origin never gets a socket at all (it sees HTTP 403), instead of getting
     * one and being closed immediately. Browsers always send `Origin` for WebSocket
     * connections; non-browser clients that omit it are refused when a list is configured,
     * which is the intended behaviour for a browser-facing service.
     */
    verifyClient: (info, done) => {
      const origin = info.req.headers.origin;
      if (matchOrigin(allowedOrigins, origin)) {
        done(true);
        return;
      }
      log.warn('rejected origin', { origin });
      done(false, 403, 'Origin not allowed');
    },
  });

  const states = new WeakMap<WebSocket, ConnectionState>();

  function safeSend(socket: WebSocket, message: ServerMessage): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      const payload = JSON.stringify(message);
      if (Buffer.byteLength(payload) > maxMessageBytes) return;
      socket.send(payload);
    } catch (error) {
      log.warn('send failed', { error: (error as Error).message });
    }
  }

  function broadcast(roomId: string, message: ServerMessage, exceptPeerId?: string): void {
    const room = manager.getRoom(roomId);
    if (!room) return;
    for (const peer of room.peers.values()) {
      if (peer.id === exceptPeerId) continue;
      peer.send(message);
    }
  }

  function takeToken(state: ConnectionState, cost = 1): boolean {
    const now = Date.now();
    const elapsed = (now - state.bucket.last) / 1000;
    state.bucket.last = now;
    state.bucket.tokens = Math.min(rateBurst, state.bucket.tokens + elapsed * ratePerSecond);
    if (state.bucket.tokens < cost) return false;
    state.bucket.tokens -= cost;
    return true;
  }

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    // The origin allow-list was already enforced in `verifyClient` above.
    const origin = request.headers.origin;
    if (serverConfig.maxConnections > 0 && wss.clients.size > serverConfig.maxConnections) {
      safeSend(socket, { type: 'ERROR', code: 'server-busy', message: 'The signaling server is busy. Try again shortly.', fatal: true });
      socket.close(1013, 'Server busy');
      return;
    }

    const state: ConnectionState = {
      peerId: null,
      greeted: false,
      invalid: 0,
      bucket: { tokens: rateBurst, last: Date.now() },
      helloDeadline: null,
      lastPong: Date.now(),
    };
    states.set(socket, state);

    if (helloTimeoutMs > 0) {
      state.helloDeadline = setTimeout(() => {
        const current = states.get(socket);
        if (current && !current.greeted) {
          safeSend(socket, { type: 'ERROR', code: 'hello-timeout', message: 'No handshake received.', fatal: true });
          socket.close(1002, 'Handshake timeout');
        }
      }, helloTimeoutMs);
      state.helloDeadline.unref?.();
    }

    socket.on('pong', () => {
      state.lastPong = Date.now();
    });

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        // Signaling is JSON only. Binary frames are always a protocol violation.
        state.invalid += 1;
        safeSend(socket, { type: 'ERROR', code: 'binary-not-allowed', message: 'Binary frames are not accepted on the signaling channel.' });
        if (state.invalid >= maxInvalid) socket.close(1003, 'Too many invalid messages');
        return;
      }
      const text = raw.toString();
      if (Buffer.byteLength(text) > maxMessageBytes) {
        state.invalid += 1;
        safeSend(socket, { type: 'ERROR', code: 'message-too-large', message: 'Signaling messages are limited to metadata.' });
        if (state.invalid >= maxInvalid) socket.close(1009, 'Message too large');
        return;
      }
      if (!takeToken(state, 1)) {
        safeSend(socket, { type: 'ERROR', code: 'rate-limited', message: 'Too many signaling messages. Slowing down.', fatal: true });
        socket.close(1008, 'Rate limit exceeded');
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        state.invalid += 1;
        safeSend(socket, { type: 'ERROR', code: 'malformed-json', message: 'Message was not valid JSON.' });
        if (state.invalid >= maxInvalid) socket.close(1003, 'Too many invalid messages');
        return;
      }

      const result = ClientMessageSchema.safeParse(parsed);
      if (!result.success) {
        state.invalid += 1;
        if (state.invalid >= maxInvalid) {
          safeSend(socket, { type: 'ERROR', code: 'invalid-message', message: 'Too many invalid messages.', fatal: true });
          socket.close(1003, 'Too many invalid messages');
          return;
        }
        safeSend(socket, { type: 'ERROR', code: 'invalid-message', message: 'That message was not understood.' });
        return;
      }

      handleMessage(socket, state, result.data, origin, request.socket.remoteAddress);
    });

    socket.on('close', () => {
      if (state.helloDeadline) clearTimeout(state.helloDeadline);
      if (!state.peerId) return;
      const left = manager.leave(state.peerId);
      if (!left) return;
      const { peer, roomDestroyed } = left;
      broadcast(peer.roomId, { type: 'PEER_LEFT', peerId: peer.id });
      log.info('peer left', { peerId: peer.id, roomId: peer.roomId, roomDestroyed });
    });

    socket.on('error', (error) => {
      log.warn('socket error', { error: (error as Error).message, peerId: state.peerId ?? undefined });
    });
  });

  function handleMessage(
    socket: WebSocket,
    state: ConnectionState,
    message: ClientMessage,
    origin: string | undefined,
    address: string | undefined,
  ): void {
    if (message.type === 'HELLO') {
      if (state.greeted && state.peerId) {
        safeSend(socket, { type: 'ERROR', code: 'already-greeted', message: 'This connection has already joined.' });
        return;
      }
      if (state.helloDeadline) {
        clearTimeout(state.helloDeadline);
        state.helloDeadline = null;
      }
      const peerId = manager.reservePeerId();
      const record: Omit<PeerRecord, 'roomId'> = {
        id: peerId,
        name: message.name,
        device: message.device,
        joinedAt: Date.now(),
        lastSeen: Date.now(),
        ...(message.key ? { key: message.key } : {}),
        origin,
        address,
        send: (outgoing) => safeSend(socket, outgoing),
        close: (code, reason) => socket.close(code, reason),
      };
      // No explicit room => the shared default room (private rooms are opt-in).
      const joinResult = manager.join(record, message.room ?? serverConfig.defaultRoom);
      if (!joinResult.ok) {
        safeSend(socket, {
          type: 'ERROR',
          code: joinResult.code,
          message: joinResult.message,
          fatal: true,
        });
        socket.close(1008, joinResult.code);
        return;
      }

      state.peerId = peerId;
      state.greeted = true;
      const { room, created } = joinResult;
      const self = manager.getPeer(peerId) as PeerRecord;

      const iceServers = buildIceServers(peerId);
      // In offline mode there is no internet: only host candidates are useful, and the
      // client should not wait on unreachable STUN servers before connecting.
      const advertisedIce = offlineMode && !serverConfig.turn.urls.length ? [] : iceServers;
      const boundPort = (() => {
        const address = httpServer.address();
        return typeof address === 'object' && address ? address.port : serverConfig.port;
      })();
      safeSend(socket, {
        type: 'WELCOME',
        selfId: peerId,
        roomId: room.id,
        name: self.name,
        peers: manager.listPeers(room.id, peerId),
        ...(advertisedIce.length ? { iceServers: advertisedIce } : {}),
        ...(offlineMode ? { offline: true } : {}),
        ...(serveFrontend
          ? { lan: { urls: joinUrls(boundPort, options.tls ? 'https' : 'http') } }
          : {}),
        limits: {
          maxPeers: options.maxPeersPerRoom ?? serverConfig.maxPeersPerRoom,
          maxMessageBytes,
          serverTime: Date.now(),
        },
        roomCreated: created,
      });
      broadcast(room.id, { type: 'PEER_JOINED', peer: manager.peerInfo(self) }, peerId);
      log.info('peer joined', { peerId, roomId: room.id, created, device: self.device });
      return;
    }

    if (!state.peerId || !state.greeted) {
      safeSend(socket, { type: 'ERROR', code: 'not-joined', message: 'Send HELLO before anything else.' });
      return;
    }
    manager.touch(state.peerId);

    switch (message.type) {
      case 'RENAME': {
        const updated = manager.rename(state.peerId, message.name);
        if (!updated) {
          safeSend(socket, { type: 'ERROR', code: 'unknown-peer', message: 'Your session has expired — reconnect.' });
          socket.close(1011, 'Unknown peer');
          return;
        }
        const peer = manager.getPeer(state.peerId) as PeerRecord;
        broadcast(peer.roomId, { type: 'PEER_UPDATED', peer: updated });
        safeSend(socket, { type: 'PEER_UPDATED', peer: updated });
        return;
      }
      case 'SIGNAL': {
        const target = manager.findSignalTarget(state.peerId, message.to);
        if (!target) {
          safeSend(socket, { type: 'ERROR', code: 'unknown-target', message: 'That device is no longer available.' });
          return;
        }
        target.send({ type: 'SIGNAL', from: state.peerId, data: message.data });
        return;
      }
      case 'PING': {
        safeSend(socket, { type: 'PONG', ...(typeof message.t === 'number' ? { t: message.t } : {}) });
        return;
      }
      case 'LEAVE': {
        socket.close(1000, 'Client left');
        return;
      }
      default:
        return;
    }
  }

  /* ---------------------------------------------------------------- *
   * Housekeeping
   * ---------------------------------------------------------------- */
  let sweepTimer: NodeJS.Timeout | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  const timersEnabled = options.timers !== false;

  if (timersEnabled) {
    sweepTimer = setInterval(() => {
      const destroyed = manager.sweep();
      if (destroyed > 0) log.debug('rooms swept', { destroyed });
    }, serverConfig.sweepIntervalMs);
    sweepTimer.unref?.();

    heartbeatTimer = setInterval(() => {
      for (const socket of wss.clients) {
        const state = states.get(socket);
        if (!state) continue;
        if (socket.readyState !== socket.OPEN) continue;
        const staleFor = Date.now() - state.lastPong;
        if (staleFor > heartbeatIntervalMs * 3) {
          log.debug('terminating stale peer', { peerId: state.peerId ?? undefined, staleFor });
          socket.terminate();
          continue;
        }
        try {
          socket.ping();
        } catch {
          socket.terminate();
        }
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
  }

  let listening = false;

  return {
    httpServer,
    wss,
    manager,
    stats: () => manager.stats(),
    async listen(): Promise<number> {
      const port = options.port ?? serverConfig.port;
      const host = options.host ?? serverConfig.host;
      if (listening) {
        const address = httpServer.address();
        return typeof address === 'object' && address ? address.port : port;
      }
      await new Promise<void>((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(port, host, () => resolve());
      });
      listening = true;
      const address = httpServer.address();
      return typeof address === 'object' && address ? address.port : port;
    },
    async close(): Promise<void> {
      if (sweepTimer) clearInterval(sweepTimer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      manager.clear();
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      if (listening) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      }
      listening = false;
    },
  };
}

/** Peer list helper re-exported for tests. */
export type { PeerInfo };
