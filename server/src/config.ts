/**
 * LANShare signaling server — configuration.
 *
 * Every value is environment-driven so the same image can run on Render, Railway,
 * Fly.io, a VPS or plain Docker without code changes.
 */
import { createHmac } from 'node:crypto';
import { resolve } from 'node:path';

function num(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function list(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Offline mode: the host runs LANShare itself on a LAN with no internet.
 *  - no external STUN servers are advertised (they are unreachable anyway, and asking for
 *    them makes ICE look broken); ICE then uses host candidates, which is all two devices
 *    on the same network need
 *  - the built frontend is served by this process, so other devices only need a URL
 * An explicitly configured `STUN_URLS`/`TURN_URLS` is always honoured, offline or not.
 */
const offlineMode = (process.env.OFFLINE_MODE ?? 'false') === 'true';

const DEFAULT_STUN = 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';
const stunUrls = list(process.env.STUN_URLS ?? (offlineMode ? '' : DEFAULT_STUN));
const turnUrls = list(process.env.TURN_URLS ?? process.env.TURN_URL ?? '');
const turnUsername = process.env.TURN_USERNAME ?? '';
const turnCredential = process.env.TURN_CREDENTIAL ?? '';
const turnSecret = process.env.TURN_SECRET ?? '';

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export const serverConfig = {
  port: num(process.env.PORT, 8080),
  host: process.env.HOST ?? '0.0.0.0',

  /** Comma separated allow-list. Empty = allow any origin (documented trade-off). */
  allowedOrigins: list(process.env.ALLOWED_ORIGINS),

  /** True when this process is the offline LAN host (no internet required). */
  offlineMode,

  /** Serve the built frontend from this process (`npm run offline`). */
  serveStatic: (process.env.SERVE_STATIC ?? 'false') === 'true',
  /** Build directory to serve; defaults to the repository's `dist/`. */
  staticRoot: resolve(process.env.STATIC_ROOT ?? resolve(process.cwd(), '..', 'dist')),
  /**
   * The single-file offline app (`npm run build:single`), offered for download so a phone can
   * keep a copy that works later with no server at all. Optional: 404s when not built.
   */
  singleFilePath: process.env.SINGLE_FILE_PATH ?? '',

  /** Optional TLS material (PEM paths). Phones need HTTPS only for PWA install. */
  tls: {
    certPath: process.env.TLS_CERT ?? '',
    keyPath: process.env.TLS_KEY ?? '',
  },

  /**
   * Room every device lands in unless it explicitly asks for another one.
   * This is what makes "open the page on two devices and they find each other" work;
   * private rooms are opt-in via a room code / QR link.
   */
  defaultRoom: (process.env.DEFAULT_ROOM ?? 'NEARBY').toUpperCase().replace(/[^A-Z0-9_-]/g, ''),
  maxPeersPerRoom: num(process.env.MAX_PEERS_PER_ROOM, 8),
  maxRooms: num(process.env.MAX_ROOMS, 5000),
  /** Largest signaling frame accepted (SDP + ICE only — never file bytes). */
  maxMessageBytes: num(process.env.MAX_MESSAGE_BYTES, 64 * 1024),
  /** A room with no traffic is destroyed after this many ms (0 disables). */
  roomTtlMs: num(process.env.ROOM_TTL_MS, 12 * 60 * 60 * 1000),
  /** How often stale rooms/peers are swept. */
  sweepIntervalMs: num(process.env.SWEEP_INTERVAL_MS, 60 * 1000),

  /** WebSocket heartbeat. */
  heartbeatIntervalMs: num(process.env.HEARTBEAT_INTERVAL_MS, 30 * 1000),
  /** A peer must send HELLO within this window or the socket is closed. */
  helloTimeoutMs: num(process.env.HELLO_TIMEOUT_MS, 10 * 1000),

  /** Token bucket: sustained messages per second + burst allowance, per connection. */
  rateLimitPerSecond: num(process.env.RATE_LIMIT_PER_SECOND, 40),
  rateLimitBurst: num(process.env.RATE_LIMIT_BURST, 120),
  /** Invalid messages tolerated before the socket is dropped. */
  maxInvalidMessages: num(process.env.MAX_INVALID_MESSAGES, 8),

  /** Cap on simultaneous connections (0 = unlimited). */
  maxConnections: num(process.env.MAX_CONNECTIONS, 0),

  /** Per-IP connection cap (best effort; only applied when not behind a proxy). */
  maxConnectionsPerIp: num(process.env.MAX_CONNECTIONS_PER_IP, 0),

  trustProxy: (process.env.TRUST_PROXY ?? 'true') !== 'false',

  /**
   * Optional coturn "REST API" ephemeral credentials.
   * When TURN_SECRET is set, short-lived TURN credentials are minted per client.
   */
  turn: {
    urls: turnUrls,
    username: turnUsername,
    credential: turnCredential,
    secret: turnSecret,
    ttlSeconds: num(process.env.TURN_TTL_SECONDS, 3600),
  },

  /** Requests that arrive outside this window of the server clock are rejected. */
  clockSkewMs: num(process.env.CLOCK_SKEW_MS, 5 * 60 * 1000),

  version: '1.0.0',
  nodeEnv: process.env.NODE_ENV ?? 'development',
} as const;

/** Build the ICE server list advertised to clients in the WELCOME message. */
export function buildIceServers(clientKey: string, now = Date.now()): IceServerConfig[] {
  const servers: IceServerConfig[] = [];
  if (stunUrls.length) {
    servers.push({ urls: stunUrls.length === 1 ? (stunUrls[0] as string) : stunUrls });
  }

  const { urls, username, credential, secret, ttlSeconds } = serverConfig.turn;
  if (urls.length) {
    if (secret) {
      const expiry = Math.floor(now / 1000) + ttlSeconds;
      const turnUser = `${expiry}:${clientKey}`;
      const signed = createHmac('sha1', secret).update(turnUser).digest('base64');
      servers.push({ urls: urls.length === 1 ? (urls[0] as string) : urls, username: turnUser, credential: signed });
    } else if (username && credential) {
      servers.push({
        urls: urls.length === 1 ? (urls[0] as string) : urls,
        username,
        credential,
      });
    }
  }
  return servers;
}

/** Match an Origin header against an allow-list (supports `*` wildcards). */
export function matchOrigin(allowList: string[], origin: string | undefined): boolean {
  if (allowList.length === 0) return true; // open by default; see README security notes
  if (!origin) return false;
  return allowList.some((allowed) => {
    if (allowed === '*') return true;
    if (allowed === origin) return true;
    if (allowed.includes('*')) {
      const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^.]*');
      return new RegExp(`^${escaped}$`).test(origin);
    }
    return false;
  });
}

export function isOriginAllowed(origin: string | undefined): boolean {
  return matchOrigin(serverConfig.allowedOrigins, origin);
}
