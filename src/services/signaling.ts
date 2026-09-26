import { randomFraction } from '../utils/id';
/**
 * Signaling client.
 *
 * Owns exactly one WebSocket to the signaling server, validates every inbound frame,
 * and reconnects with exponential backoff. Only connection metadata travels here —
 * file bytes always go over the WebRTC data channel.
 */
import { config } from '../config';
import {
  MAX_SIGNALING_MESSAGE_BYTES,
  parseServerMessage,
  type ClientMessage,
  type DeviceKind,
  type PeerInfo,
  type SignalData,
  type WelcomeMessage,
} from '../types/protocol';
import { log } from './logger';

export type SignalingState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'error' | 'closed';

export interface SignalingIdentity {
  name: string;
  device: DeviceKind;
  key?: string;
  room?: string;
}

export interface SignalingHandlers {
  onWelcome?: (welcome: WelcomeMessage) => void;
  onPeers?: (peers: PeerInfo[]) => void;
  onPeerJoined?: (peer: PeerInfo) => void;
  onPeerLeft?: (peerId: string) => void;
  onPeerUpdated?: (peer: PeerInfo) => void;
  onSignal?: (from: string, data: SignalData) => void;
  onState?: (state: SignalingState, attempts: number) => void;
  onError?: (message: string, fatal: boolean) => void;
}

export class SignalingClient {
  private socket: WebSocket | null = null;
  private handlers: SignalingHandlers;
  private identity: SignalingIdentity;
  private state: SignalingState = 'idle';
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private manualClose = false;
  private pendingRoom: string | undefined;
  private lastLatency: number | null = null;
  private onlineListener: (() => void) | null = null;

  constructor(
    private readonly url: string,
    identity: SignalingIdentity,
    handlers: SignalingHandlers = {},
  ) {
    this.identity = { ...identity };
    this.handlers = handlers;
    this.pendingRoom = identity.room;
    this.watchNetwork();
  }

  /**
   * Reconnect the moment the browser reports connectivity again instead of waiting for the
   * next backoff tick. A page that booted while offline can otherwise sit out its whole
   * (capped) backoff window before it even tries again.
   */
  private watchNetwork(): void {
    if (this.onlineListener || typeof window === 'undefined') return;
    this.onlineListener = () => {
      if (this.manualClose || this.state === 'connected') return;
      log.debug('signaling: network is back — reconnecting immediately');
      this.retryNow();
    };
    window.addEventListener('online', this.onlineListener);
  }

  private unwatchNetwork(): void {
    if (this.onlineListener && typeof window !== 'undefined') {
      window.removeEventListener('online', this.onlineListener);
    }
    this.onlineListener = null;
  }

  get selfId(): string | null {
    return this.selfIdValue;
  }

  private selfIdValue: string | null = null;
  private roomIdValue: string | null = null;

  get roomId(): string | null {
    return this.roomIdValue;
  }

  get latencyMs(): number | null {
    return this.lastLatency;
  }

  get currentState(): SignalingState {
    return this.state;
  }

  get isOpen(): boolean {
    return this.socket?.readyState === WebSocket.OPEN && this.state === 'connected';
  }

  setIdentity(patch: Partial<SignalingIdentity>): void {
    this.identity = { ...this.identity, ...patch };
  }

  connect(): void {
    this.watchNetwork();
    if (!this.url) {
      this.setState('error');
      this.handlers.onError?.(
        'No signaling server is configured. Set VITE_SIGNALING_URL to your WebSocket server URL.',
        true,
      );
      return;
    }
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.manualClose = false;
    this.setState(this.attempts > 0 ? 'reconnecting' : 'connecting');
    log.debug('signaling: connecting', { url: this.url, attempt: this.attempts });

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.url);
    } catch (error) {
      log.warn('signaling: constructor failed', { error: (error as Error).message });
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      log.debug('signaling: socket open');
      this.send({
        type: 'HELLO',
        name: this.identity.name,
        device: this.identity.device,
        ...(this.identity.key ? { key: this.identity.key } : {}),
        ...(this.pendingRoom ? { room: this.pendingRoom } : {}),
      });
      this.startPing();
    };

    socket.onmessage = (event: MessageEvent) => {
      if (typeof event.data !== 'string') {
        log.warn('signaling: dropped non-string frame');
        return;
      }
      if (event.data.length > MAX_SIGNALING_MESSAGE_BYTES) {
        log.warn('signaling: oversized frame dropped', { bytes: event.data.length });
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(event.data);
      } catch {
        log.warn('signaling: malformed JSON dropped');
        return;
      }
      const message = parseServerMessage(raw);
      if (!message) return;

      switch (message.type) {
        case 'WELCOME': {
          this.selfIdValue = message.selfId;
          this.roomIdValue = message.roomId;
          this.attempts = 0;
          this.setState('connected');
          this.handlers.onWelcome?.(message);
          this.handlers.onPeers?.(message.peers);
          return;
        }
        case 'PEER_LIST':
          this.handlers.onPeers?.(message.peers);
          return;
        case 'PEER_JOINED':
          this.handlers.onPeerJoined?.(message.peer);
          return;
        case 'PEER_LEFT':
          this.handlers.onPeerLeft?.(message.peerId);
          return;
        case 'PEER_UPDATED':
          this.handlers.onPeerUpdated?.(message.peer);
          return;
        case 'SIGNAL':
          this.handlers.onSignal?.(message.from, message.data);
          return;
        case 'PONG':
          return;
        case 'ERROR': {
          if (message.code === 'rate-limited') log.warn('signaling: rate limited by server');
          this.handlers.onError?.(message.message, message.fatal === true);
          if (message.fatal) {
            this.manualClose = true;
            this.setState('error');
            socket.close(1000, 'fatal');
          }
          return;
        }
        default:
          return;
      }
    };

    socket.onclose = (event) => {
      this.stopPing();
      this.selfIdValue = null;
      this.roomIdValue = null;
      if (this.manualClose) {
        this.setState('closed');
        return;
      }
      log.debug('signaling: closed', { code: event.code, reason: event.reason });
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // The close handler performs the retry; keep logs quiet in production.
      log.debug('signaling: socket error');
    };
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    const { baseDelayMs, maxDelayMs, maxAttempts, jitter } = config.reconnect;
    if (this.attempts >= maxAttempts) {
      this.setState('error');
      this.handlers.onError?.(
        'Lost contact with the connection service. Check your network and try again.',
        true,
      );
      return;
    }
    this.attempts += 1;
    const exponential = Math.min(maxDelayMs, baseDelayMs * 2 ** (this.attempts - 1));
    const delay = Math.round(exponential * (1 - jitter + randomFraction() * jitter * 2));
    this.setState('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      const sentAt = Date.now();
      this.sendRaw({ type: 'PING', t: sentAt });
      this.lastLatency = Date.now() - sentAt;
    }, 25_000);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private setState(state: SignalingState): void {
    if (this.state === state) return;
    this.state = state;
    this.handlers.onState?.(state, this.attempts);
  }

  private sendRaw(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const payload = JSON.stringify(message);
    if (payload.length > MAX_SIGNALING_MESSAGE_BYTES) {
      log.warn('signaling: refusing to send oversized message');
      return;
    }
    this.socket.send(payload);
  }

  send(message: ClientMessage): void {
    this.sendRaw(message);
  }

  signal(to: string, data: SignalData): void {
    this.sendRaw({ type: 'SIGNAL', to, data });
  }

  rename(name: string): void {
    this.identity.name = name;
    this.sendRaw({ type: 'RENAME', name });
  }

  /** Ask the server for a specific room on the next (re)connect. */
  setRoom(room: string | undefined): void {
    this.pendingRoom = room;
  }

  /** Manual retry after a fatal error (resets the backoff counter). */
  retryNow(): void {
    this.manualClose = false;
    this.attempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.socket?.close(1000, 'client retry');
    this.socket = null;
    this.connect();
  }

  disconnect(): void {
    this.manualClose = true;
    this.unwatchNetwork();
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      if (this.socket?.readyState === WebSocket.OPEN) this.sendRaw({ type: 'LEAVE' });
      this.socket?.close(1000, 'client closing');
    } catch {
      /* ignore */
    }
    this.socket = null;
    this.selfIdValue = null;
    this.roomIdValue = null;
    this.setState('closed');
  }
}
