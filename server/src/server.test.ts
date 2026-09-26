import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { createSignalingServer, type SignalingServer } from './server.js';
import { RoomManager } from './rooms.js';
import { matchOrigin } from './config.js';
import type { ServerMessage } from './protocol.js';

interface TestClient {
  socket: WebSocket;
  messages: ServerMessage[];
  raw: string[];
  /** Wait for a message matching the predicate. */
  waitFor: (predicate: (message: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
  send: (payload: unknown) => void;
  sendRaw: (payload: string) => void;
  close: () => Promise<void>;
  closed: Promise<{ code: number; reason: string }>;
}

function connect(url: string, origin = 'https://lanshare.example'): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    const messages: ServerMessage[] = [];
    const raw: string[] = [];
    const waiters: Array<{ predicate: (message: ServerMessage) => boolean; resolve: (message: ServerMessage) => void }> = [];

    socket.on('message', (data) => {
      const text = data.toString();
      raw.push(text);
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(text) as ServerMessage;
      } catch {
        return;
      }
      messages.push(parsed);
      for (let index = waiters.length - 1; index >= 0; index -= 1) {
        const waiter = waiters[index];
        if (waiter && waiter.predicate(parsed)) {
          waiters.splice(index, 1);
          waiter.resolve(parsed);
        }
      }
    });

    let resolveClosed: (value: { code: number; reason: string }) => void = () => undefined;
    const closed = new Promise<{ code: number; reason: string }>((resolveClose) => {
      resolveClosed = resolveClose;
    });
    socket.on('close', (code, reason) => resolveClosed({ code, reason: reason.toString() }));
    socket.on('error', () => undefined);

    socket.on('open', () => {
      resolve({
        socket,
        messages,
        raw,
        closed,
        send: (payload) => socket.send(JSON.stringify(payload)),
        sendRaw: (payload) => socket.send(payload),
        waitFor: (predicate, timeoutMs = 3000) =>
          new Promise<ServerMessage>((resolveWait, rejectWait) => {
            const existing = messages.find(predicate);
            if (existing) {
              resolveWait(existing);
              return;
            }
            const timer = setTimeout(() => {
              rejectWait(new Error(`Timed out waiting for a message. Received: ${messages.map((m) => m.type).join(', ')}`));
            }, timeoutMs);
            waiters.push({
              predicate,
              resolve: (message) => {
                clearTimeout(timer);
                resolveWait(message);
              },
            });
          }),
        close: () =>
          new Promise<void>((resolveClose) => {
            if (socket.readyState === WebSocket.CLOSED) {
              resolveClose();
              return;
            }
            socket.once('close', () => resolveClose());
            socket.close();
          }),
      });
    });
    socket.on('error', reject);
  });
}

describe('signaling server', () => {
  let server: SignalingServer;
  let url: string;
  const clients: TestClient[] = [];

  beforeEach(async () => {
    server = createSignalingServer({ port: 0, host: '127.0.0.1', timers: false, allowedOrigins: [] });
    const port = await server.listen();
    url = `ws://127.0.0.1:${port}/ws`;
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await server.close();
  });

  async function open(origin?: string): Promise<TestClient> {
    const client = await connect(url, origin);
    clients.push(client);
    return client;
  }

  async function hello(client: TestClient, name: string, room?: string, key?: string): Promise<ServerMessage> {
    client.send({ type: 'HELLO', name, device: 'desktop', ...(room ? { room } : {}), ...(key ? { key } : {}) });
    return client.waitFor((message) => message.type === 'WELCOME');
  }

  it('answers HELLO with a WELCOME containing a temporary id and the shared default room', async () => {
    const client = await open();
    const welcome = (await hello(client, 'Blue Falcon')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    expect(welcome.selfId).toMatch(/^[a-z0-9]{6,}$/);
    // Devices that do not request a room all land in the same room, which is what makes
    // "open the page on two devices and they find each other" work.
    expect(welcome.roomId).toBe('NEARBY');
    expect(welcome.peers).toEqual([]);
    expect(welcome.roomCreated).toBe(true);
    expect(welcome.limits.maxMessageBytes).toBeGreaterThan(0);
    expect(welcome.iceServers?.length).toBeGreaterThan(0);
  });

  it('places two plain clients in the same default room and lists them for each other', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon');
    const b = await open();
    const welcomeB = (await hello(b, 'Silent Panda')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    expect(welcomeB.roomId).toBe('NEARBY');
    expect(welcomeB.peers.map((peer) => peer.name)).toEqual(['Blue Falcon']);
    const welcomeA = a.messages.find((message) => message.type === 'WELCOME');
    expect(welcomeA).toBeTruthy();
  });

  it('publishes ICE configuration (STUN by default, no credentials leak)', async () => {
    const client = await open();
    const welcome = (await hello(client, 'Blue Falcon')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    const serialised = JSON.stringify(welcome.iceServers);
    expect(serialised).toContain('stun:');
    expect(serialised).not.toMatch(/credential/i);
  });

  it('notifies existing peers when another device joins the same room', async () => {
    const a = await open();
    const welcome = (await hello(a, 'Blue Falcon', 'ROOM01')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    expect(welcome.roomId).toBe('ROOM01');

    const b = await open();
    await hello(b, 'Silent Panda', 'ROOM01');

    const joined = (await a.waitFor((message) => message.type === 'PEER_JOINED')) as Extract<
      ServerMessage,
      { type: 'PEER_JOINED' }
    >;
    expect(joined.peer.name).toBe('Silent Panda');
    expect(joined.peer.device).toBe('desktop');
  });

  it('sends the existing peer list to the newcomer', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon', 'ROOM01');
    const b = await open();
    const welcome = (await hello(b, 'Silent Panda', 'ROOM01')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    expect(welcome.peers).toHaveLength(1);
    expect(welcome.peers[0]?.name).toBe('Blue Falcon');
  });

  it('forwards WebRTC signaling between two peers in the same room', async () => {
    const a = await open();
    const welcomeA = (await hello(a, 'Blue Falcon', 'ROOM01')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    const b = await open();
    const welcomeB = (await hello(b, 'Silent Panda', 'ROOM01')) as Extract<ServerMessage, { type: 'WELCOME' }>;

    a.send({ type: 'SIGNAL', to: welcomeB.selfId, data: { kind: 'offer', sdp: 'v=0 test-offer' } });
    const signal = (await b.waitFor((message) => message.type === 'SIGNAL')) as Extract<ServerMessage, { type: 'SIGNAL' }>;
    expect(signal.from).toBe(welcomeA.selfId);
    expect(signal.data).toEqual({ kind: 'offer', sdp: 'v=0 test-offer' });

    b.send({
      type: 'SIGNAL',
      to: welcomeA.selfId,
      data: { kind: 'ice', candidate: { candidate: 'candidate:1 udp', sdpMid: '0', sdpMLineIndex: 0 } },
    });
    const ice = (await a.waitFor((message) => message.type === 'SIGNAL')) as Extract<ServerMessage, { type: 'SIGNAL' }>;
    expect(ice.data.kind).toBe('ice');
  });

  it('refuses signaling to a peer that is in another room', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon', 'ROOM01');
    const b = await open();
    const welcomeB = (await hello(b, 'Silent Panda', 'ROOM02')) as Extract<ServerMessage, { type: 'WELCOME' }>;

    a.send({ type: 'SIGNAL', to: welcomeB.selfId, data: { kind: 'offer', sdp: 'v=0 x' } });
    const error = (await a.waitFor((message) => message.type === 'ERROR')) as Extract<ServerMessage, { type: 'ERROR' }>;
    expect(error.code).toBe('unknown-target');
  });

  it('rejects JSON that is not a known message type', async () => {
    const client = await open();
    client.sendRaw(JSON.stringify({ type: 'DROP_TABLE', table: 'peers' }));
    const error = (await client.waitFor((message) => message.type === 'ERROR')) as Extract<ServerMessage, { type: 'ERROR' }>;
    expect(error.code).toBe('invalid-message');
  });

  it('rejects malformed JSON without crashing', async () => {
    const client = await open();
    client.sendRaw('{not json at all');
    const error = (await client.waitFor((message) => message.type === 'ERROR')) as Extract<ServerMessage, { type: 'ERROR' }>;
    expect(error.code).toBe('malformed-json');
  });

  it('rejects binary frames outright (signaling is metadata only)', async () => {
    const client = await open();
    await hello(client, 'Blue Falcon');
    client.socket.send(Buffer.from([1, 2, 3, 4]));
    const error = (await client.waitFor((message) => message.type === 'ERROR')) as Extract<ServerMessage, { type: 'ERROR' }>;
    expect(error.code).toBe('binary-not-allowed');
  });

  it('rejects oversized payloads before they reach application state', async () => {
    const client = await open();
    let sawError: string | null = null;
    try {
      await hello(client, 'Blue Falcon');
      const huge = JSON.stringify({ type: 'SIGNAL', to: 'peer', data: { kind: 'offer', sdp: 'x'.repeat(200_000) } });
      client.sendRaw(huge);
      const error = (await client.waitFor((message) => message.type === 'ERROR')) as Extract<
        ServerMessage,
        { type: 'ERROR' }
      >;
      sawError = error.code;
    } catch {
      sawError = null;
    }
    // Either our own guard answers, or the transport drops the frame — both are fine
    // as long as the oversized message never reaches another peer's state.
    if (sawError) {
      expect(['message-too-large', 'invalid-message']).toContain(sawError);
    } else {
      const closed = await client.closed;
      expect([1009, 1006]).toContain(closed.code);
    }
  });

  it('drops clients that keep sending invalid messages', async () => {
    const client = await open();
    for (let index = 0; index < 12; index += 1) client.sendRaw('nonsense');
    const closed = await client.closed;
    expect([1003, 1009]).toContain(closed.code);
  });

  it('requires HELLO before any other message', async () => {
    const client = await open();
    client.send({ type: 'SIGNAL', to: 'someone', data: { kind: 'offer', sdp: 'x' } });
    const error = (await client.waitFor((message) => message.type === 'ERROR')) as Extract<ServerMessage, { type: 'ERROR' }>;
    expect(error.code).toBe('not-joined');
  });

  it('answers PING with PONG', async () => {
    const client = await open();
    await hello(client, 'Blue Falcon');
    client.send({ type: 'PING', t: 42 });
    const pong = (await client.waitFor((message) => message.type === 'PONG')) as Extract<ServerMessage, { type: 'PONG' }>;
    expect(pong.t).toBe(42);
  });

  it('broadcasts a rename to everyone in the room, including the author', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon', 'ROOM01');
    const b = await open();
    await hello(b, 'Silent Panda', 'ROOM01');

    b.send({ type: 'RENAME', name: 'Anas Phone' });
    const updatedForA = (await a.waitFor(
      (message) => message.type === 'PEER_UPDATED' && message.peer.name === 'Anas Phone',
    )) as Extract<ServerMessage, { type: 'PEER_UPDATED' }>;
    expect(updatedForA.peer.name).toBe('Anas Phone');
  });

  it('disambiguates duplicate device names inside a room', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon', 'ROOM01');
    const b = await open();
    const welcomeB = (await hello(b, 'Blue Falcon', 'ROOM01')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    expect(welcomeB.name).toBe('Blue Falcon 2');
  });

  it('notifies the room and destroys it when the last peer leaves', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon', 'ROOM01');
    const b = await open();
    await hello(b, 'Silent Panda', 'ROOM01');
    expect(server.manager.roomCount()).toBe(1);

    await b.close();
    const left = (await a.waitFor((message) => message.type === 'PEER_LEFT')) as Extract<ServerMessage, { type: 'PEER_LEFT' }>;
    expect(left.peerId).toBeTruthy();

    await a.close();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(server.manager.roomCount()).toBe(0);
    expect(server.manager.peerCount()).toBe(0);
  });

  it('removes stale peers when a socket drops without a LEAVE', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon', 'ROOM01');
    const b = await open();
    await hello(b, 'Silent Panda', 'ROOM01');
    b.socket.terminate();
    await a.waitFor((message) => message.type === 'PEER_LEFT');
    expect(server.manager.peerCount()).toBe(1);
  });

  it('enforces the per-room peer limit', async () => {
    const small = createSignalingServer({ port: 0, host: '127.0.0.1', timers: false, maxPeersPerRoom: 2, allowedOrigins: [] });
    const port = await small.listen();
    const clientsLocal: TestClient[] = [];
    try {
      for (let index = 0; index < 2; index += 1) {
        const client = await connect(`ws://127.0.0.1:${port}/ws`);
        clientsLocal.push(client);
        client.send({ type: 'HELLO', name: `Device ${index}`, device: 'mobile', room: 'FULL01' });
        await client.waitFor((message) => message.type === 'WELCOME');
      }
      const extra = await connect(`ws://127.0.0.1:${port}/ws`);
      clientsLocal.push(extra);
      extra.send({ type: 'HELLO', name: 'Late device', device: 'mobile', room: 'FULL01' });
      const error = (await extra.waitFor((message) => message.type === 'ERROR')) as Extract<ServerMessage, { type: 'ERROR' }>;
      expect(error.code).toBe('room-full');
      expect(error.fatal).toBe(true);
    } finally {
      await Promise.all(clientsLocal.map((client) => client.close()));
      await small.close();
    }
  });

  it('carries the client key through peer lists so links survive reconnects', async () => {
    const a = await open();
    await hello(a, 'Blue Falcon', 'ROOM01', 'clientkey0001');
    const b = await open();
    const welcomeB = (await hello(b, 'Silent Panda', 'ROOM01', 'clientkey0002')) as Extract<
      ServerMessage,
      { type: 'WELCOME' }
    >;
    expect(welcomeB.peers[0]?.key).toBe('clientkey0001');
  });

  it('rate-limits a flooding socket and closes it with a fatal error', async () => {
    // A tiny bucket keeps the test fast and deterministic: 2 tokens/second, burst of 5.
    const limited = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      timers: false,
      allowedOrigins: [],
      rateLimitPerSecond: 2,
      rateLimitBurst: 5,
    });
    const limitedUrl = `ws://127.0.0.1:${(await limited.listen())}/ws`;
    const client = await connect(limitedUrl);
    clients.push(client);
    try {
      client.send({ type: 'HELLO', room: 'NEARBY', name: 'Flooder', device: 'desktop' });
      await client.waitFor((message) => message.type === 'WELCOME');

      // Burn the remaining burst (HELLO already used one token), then flood.
      for (let index = 0; index < 30; index += 1) client.send({ type: 'PING', t: index });
      const limitError = await client.waitFor(
        (message) => message.type === 'ERROR' && (message as { code?: string }).code === 'rate-limited',
        5000,
      );
      expect((limitError as { fatal?: boolean }).fatal).toBe(true);

      // The flood must be cut off, not merely warned about.
      const closed = await client.closed;
      expect(closed.code).toBe(1008);
      expect(closed.reason).toMatch(/rate limit/i);
    } finally {
      await limited.close();
    }
  });

  it('recovers the token bucket — a normal client is never throttled by a short burst', async () => {
    // Same small bucket, but the messages are spaced out: correct pacing stays connected.
    const server2 = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      timers: false,
      allowedOrigins: [],
      rateLimitPerSecond: 20,
      rateLimitBurst: 10,
    });
    const url2 = `ws://127.0.0.1:${(await server2.listen())}/ws`;
    const client = await connect(url2);
    clients.push(client);
    try {
      client.send({ type: 'HELLO', room: 'NEARBY', name: 'Paced', device: 'desktop' });
      await client.waitFor((message) => message.type === 'WELCOME');
      for (let index = 0; index < 6; index += 1) {
        client.send({ type: 'PING', t: index });
        const pong = await client.waitFor((message) => message.type === 'PONG' && (message as { t?: number }).t === index);
        expect(pong.type).toBe('PONG');
        await new Promise((resolve) => setTimeout(resolve, 80)); // 12.5 msg/s < 20/s
      }
      expect(client.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await server2.close();
    }
  });

  it('never tunnels file payloads — extra fields on signaling messages are rejected', async () => {
    const a = await open();
    const welcomeA = (await hello(a, 'Blue Falcon', 'ROOM01')) as Extract<ServerMessage, { type: 'WELCOME' }>;
    const b = await open();
    await hello(b, 'Silent Panda', 'ROOM01');

    // A peer trying to smuggle file bytes through the signaling channel.
    a.sendRaw(
      JSON.stringify({
        type: 'SIGNAL',
        to: welcomeA.selfId,
        data: { kind: 'offer', sdp: 'v=0', files: [{ name: 'secret.zip', data: 'QkFTRTY0' }] },
      }),
    );
    const error = (await a.waitFor((message) => message.type === 'ERROR')) as Extract<ServerMessage, { type: 'ERROR' }>;
    expect(error.code).toBe('invalid-message');
    // Nothing resembling the smuggled payload reached the other peer.
    expect(JSON.stringify(b.messages)).not.toContain('QkFTRTY0');
  });

  it('exposes a health endpoint without leaking internals', async () => {
    const address = server.httpServer.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(Object.keys(body)).not.toContain('peersList');
  });
});

describe('origin allow-list', () => {
  it('allows everything when the list is empty (documented default)', () => {
    expect(matchOrigin([], 'https://anything.example')).toBe(true);
  });

  it('matches exact origins and wildcards', () => {
    const list = ['https://anas.github.io', 'https://*.example.com'];
    expect(matchOrigin(list, 'https://anas.github.io')).toBe(true);
    expect(matchOrigin(list, 'https://app.example.com')).toBe(true);
    expect(matchOrigin(list, 'https://evil.test')).toBe(false);
    expect(matchOrigin(list, undefined)).toBe(false);
  });

  it('refuses the WebSocket handshake for a disallowed origin', async () => {
    const server = createSignalingServer({
      port: 0,
      host: '127.0.0.1',
      timers: false,
      allowedOrigins: ['https://allowed.example'],
    });
    const port = await server.listen();
    try {
      // The upgrade itself is refused (HTTP 403) — a blocked page never gets a socket,
      // so there is no window in which it could send anything.
      const failure = await new Promise<{ statusCode?: number; message: string }>((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Origin: 'https://blocked.example' } });
        socket.on('unexpected-response', (_request, response) => {
          resolve({ statusCode: response.statusCode, message: 'unexpected-response' });
        });
        socket.on('open', () => resolve({ message: 'opened' }));
        socket.on('error', (error) => resolve({ message: error.message }));
      });
      expect(failure.message).not.toBe('opened');
      expect(failure.statusCode ?? 403).toBe(403);

      // And the allowed origin still works, with a normal handshake.
      const allowed = await connect(`ws://127.0.0.1:${port}/ws`, 'https://allowed.example');
      allowed.send({ type: 'HELLO', room: 'NEARBY', name: 'Allowed', device: 'desktop' });
      const welcome = await allowed.waitFor((message) => message.type === 'WELCOME');
      expect(welcome.type).toBe('WELCOME');
      await allowed.close();
    } finally {
      await server.close();
    }
  });
});

describe('RoomManager', () => {
  it('generates unpredictable ids and tidies up empty rooms', () => {
    const manager = new RoomManager({ maxPeersPerRoom: 4, maxRooms: 10, roomTtlMs: 1000 });
    const idA = manager.reserveRoomId();
    const idB = manager.reserveRoomId();
    expect(idA).not.toBe(idB);
    expect(idA).toMatch(/^[A-Z0-9]{6}$/);

    const peer = {
      id: manager.reservePeerId(),
      name: 'Tester',
      device: 'desktop' as const,
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      send: () => undefined,
      close: () => undefined,
    };
    const joined = manager.join(peer);
    expect(joined.ok).toBe(true);
    expect(manager.roomCount()).toBe(1);

    manager.leave(peer.id);
    expect(manager.roomCount()).toBe(0);
    expect(manager.peerCount()).toBe(0);
  });

  it('sweeps idle rooms', () => {
    const manager = new RoomManager({ maxPeersPerRoom: 4, maxRooms: 10, roomTtlMs: 10 });
    manager.join({
      id: 'abcdef',
      name: 'Tester',
      device: 'desktop',
      joinedAt: Date.now(),
      lastSeen: Date.now(),
      send: () => undefined,
      close: () => undefined,
    });
    expect(manager.roomCount()).toBe(1);
    expect(manager.sweep(Date.now() + 60_000)).toBe(1);
    expect(manager.roomCount()).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * Offline LAN mode (`npm run offline`)
 * ------------------------------------------------------------------ */

describe('offline LAN mode', () => {
  let server: SignalingServer | null = null;
  let port = 0;
  let staticRoot = '';
  let buildDir = '';

  beforeEach(async () => {
    buildDir = mkdtempSync(join(tmpdir(), 'lanshare-build-'));
    staticRoot = buildDir;
    writeFileSync(join(buildDir, 'index.html'), '<!doctype html><title>LANShare offline</title>');
    mkdirSync(join(buildDir, 'assets'));
    writeFileSync(join(buildDir, 'assets', 'index-abc.js'), 'console.log("built");');
    server = createSignalingServer({
      port: 0,
      timers: false,
      serveStatic: true,
      staticRoot,
      offlineMode: true,
    });
    port = await server.listen();
  });

  afterEach(async () => {
    await server?.close();
    server = null;
    rmSync(buildDir, { recursive: true, force: true });
  });

  it('serves the built frontend from the same port as signaling', async () => {
    const index = await fetch(`http://127.0.0.1:${port}/`);
    expect(index.status).toBe(200);
    expect(index.headers.get('content-type')).toContain('text/html');
    expect(await index.text()).toContain('LANShare offline');

    const asset = await fetch(`http://127.0.0.1:${port}/assets/index-abc.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect(asset.headers.get('cache-control')).toContain('immutable');

    // The health endpoint must keep working next to the frontend.
    const health = await fetch(`http://127.0.0.1:${port}/health`);
    expect(health.status).toBe(200);
    expect((await health.json()).status).toBe('ok');
  });

  it('answers unknown routes with the shell but refuses to leave the build directory', async () => {
    const route = await fetch(`http://127.0.0.1:${port}/some/client/route`);
    expect(route.status).toBe(200);
    expect(await route.text()).toContain('LANShare offline');

    for (const attempt of ['/../package.json', '/%2e%2e%2fpackage.json', '/assets/../../package.json']) {
      const response = await fetch(`http://127.0.0.1:${port}${attempt}`);
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain('"devDependencies"');
    }
  });

  it('advertises no external ICE servers and flags the session as offline', async () => {
    const client = await connect(`ws://127.0.0.1:${port}/ws`);
    client.send({ type: 'HELLO', name: 'Offline Host', device: 'desktop' });
    const welcome = (await client.waitFor((message) => message.type === 'WELCOME')) as Extract<
      ServerMessage,
      { type: 'WELCOME' }
    >;
    // No internet means no STUN/TURN can be reached; advertising one would only stall ICE.
    expect(welcome.iceServers ?? []).toEqual([]);
    expect(welcome.offline).toBe(true);
    // The host tells its own UI which addresses the other devices should open.
    expect(Array.isArray(welcome.lan?.urls)).toBe(true);
    await client.close();
  });

  it('still pairs two devices with host candidates only', async () => {
    const a = await connect(`ws://127.0.0.1:${port}/ws`);
    a.send({ type: 'HELLO', name: 'First Device', device: 'desktop' });
    const welcomeA = (await a.waitFor((message) => message.type === 'WELCOME')) as Extract<
      ServerMessage,
      { type: 'WELCOME' }
    >;

    const b = await connect(`ws://127.0.0.1:${port}/ws`);
    b.send({ type: 'HELLO', name: 'Second Device', device: 'mobile' });
    const welcomeB = (await b.waitFor((message) => message.type === 'WELCOME')) as Extract<
      ServerMessage,
      { type: 'WELCOME' }
    >;

    // Discovery and the SDP/ICE relay are all the host has to provide; the bytes never come here.
    a.send({ type: 'SIGNAL', to: welcomeB.selfId, data: { kind: 'offer', sdp: 'v=0\r\ns=offline\r\n' } });
    const relayed = (await b.waitFor((message) => message.type === 'SIGNAL')) as Extract<
      ServerMessage,
      { type: 'SIGNAL' }
    >;
    expect(relayed.from).toBe(welcomeA.selfId);
    expect(relayed.data).toEqual({ kind: 'offer', sdp: 'v=0\r\ns=offline\r\n' });

    await a.close();
    await b.close();
  });
});
