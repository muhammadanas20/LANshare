/**
 * LANShare — central configuration.
 *
 * Every tunable lives here; components and services must not hardcode values.
 * Change `APP_NAME` to rebrand the whole application.
 */

export const APP_NAME = (import.meta.env.VITE_APP_NAME as string | undefined)?.trim() || 'LANShare';
export const CREATOR = 'Muhammad Anas';
export const TAGLINE = 'Share anything. Nearby. Instantly.';
export const AUTHOR_URL = (import.meta.env.VITE_AUTHOR_URL as string | undefined) || 'https://github.com/';
export const REPO_URL =
  (import.meta.env.VITE_REPO_URL as string | undefined) ||
  'https://github.com/muhammad-anas/lan-share';
export const APP_VERSION = '1.0.0';

export type SignalingMode = 'configured' | 'same-origin' | 'missing';

function isSecurePage(): boolean {
  if (typeof window === 'undefined') return true;
  return (
    window.isSecureContext ||
    window.location.protocol === 'https:' ||
    ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)
  );
}

/**
 * Resolve the signaling WebSocket URL.
 *
 * 1. `VITE_SIGNALING_URL` (preferred, required for GitHub Pages / any split deployment).
 * 2. Otherwise fall back to `<origin>/ws`, which the bundled dev/preview server proxies to the
 *    local signaling server — handy for LAN testing without a reverse proxy.
 */
export function resolveSignaling(): { url: string; mode: SignalingMode } {
  const raw = ((import.meta.env.VITE_SIGNALING_URL as string | undefined) || '').trim();
  if (raw) {
    let url = raw;
    if (!/^wss?:\/\//i.test(url)) {
      url = `${isSecurePage() ? 'wss' : 'ws'}://${url.replace(/^https?:\/\//i, '')}`;
    }
    return { url, mode: 'configured' };
  }

  if (typeof window === 'undefined') return { url: '', mode: 'missing' };

  const { protocol, host, hostname } = window.location;

  // A page opened straight from disk (the single-file offline build) has no origin to talk to:
  // there is no server, by construction. Report that instead of building a `ws:///ws` URL,
  // which is what the user-facing "pair without a server" flow is for.
  if (protocol === 'file:' || !host) {
    return { url: '', mode: 'missing' };
  }

  const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(hostname) || hostname.endsWith('.local');
  const isStaticHost = /\.github\.io$/i.test(hostname) || hostname.endsWith('gitlab.io');

  if (isLocalHost) {
    return { url: `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`, mode: 'same-origin' };
  }
  if (isStaticHost) {
    // Static hosting cannot serve a WebSocket — the operator must configure VITE_SIGNALING_URL.
    return { url: '', mode: 'missing' };
  }
  return { url: `${protocol === 'https:' ? 'wss' : 'ws'}://${host}/ws`, mode: 'same-origin' };
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

function parseIceServers(): RTCIceServer[] {
  const raw = ((import.meta.env.VITE_ICE_SERVERS as string | undefined) || '').trim();
  if (!raw) return DEFAULT_ICE_SERVERS;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    // An explicit empty array is honoured (useful for isolated/local testing).
    const valid = parsed.filter(
      (entry): entry is RTCIceServer => !!entry && typeof entry === 'object' && 'urls' in entry,
    );
    return valid;
  } catch {
    console.warn('[LANShare] VITE_ICE_SERVERS is not valid JSON — using default STUN servers.');
    return DEFAULT_ICE_SERVERS;
  }
}

const signaling = resolveSignaling();

export const config = {
  appName: APP_NAME,
  creator: CREATOR,
  tagline: TAGLINE,
  version: APP_VERSION,
  repoUrl: REPO_URL,
  authorUrl: AUTHOR_URL,

  /** WebSocket endpoint of the signaling server (negotiation only — never file data). */
  signalingUrl: signaling.url,
  signalingMode: signaling.mode,

  /** RTCIceServer list. Overridable at runtime by the signaling server's `WELCOME` message. */
  iceServers: parseIceServers(),

  /** Query-string parameter used for private room pairing links (`?room=ABC123`). */
  roomParam: 'room',

  /** File transfer tuning. */
  chunkSize: 64 * 1024, // 64 KiB per data-channel frame
  bufferedAmountLowThreshold: 1 * 1024 * 1024, // 1 MiB
  maxBufferedAmount: 8 * 1024 * 1024, // pause sending above 8 MiB in flight
  maxFileCount: 300,
  maxSingleFileBytes: 64 * 1024 * 1024 * 1024, // 64 GiB sanity guard
  maxTotalBytes: 256 * 1024 * 1024 * 1024,

  /** WebRTC timing. */
  rtcConnectTimeoutMs: 20_000,
  rtcIceRestartAfterMs: 8_000,
  keepAliveIntervalMs: 10_000,

  /** Signaling reconnect (exponential backoff, capped). */
  reconnect: {
    baseDelayMs: 600,
    maxDelayMs: 10_000,
    maxAttempts: 12,
    jitter: 0.25,
  },

  /**
   * Serverless pairing (no signaling server): how long to wait for ICE gathering before
   * serialising a session description for the user to carry to the other device.
   */
  manualPairing: {
    /**
     * How long to wait for candidate gathering before serialising. Measured: this normally
     * completes in milliseconds with host candidates, but a browser whose mDNS responder is
     * busy (for example a second browser instance starting up at the same time) can take
     * seconds, so the window is generous.
     */
    iceGatherTimeoutMs: 8_000,
    /** Largest payload we will render as a QR code (beyond this, text only). */
    maxQrPayloadChars: 2_400,
  },

  /** Incoming transfer request expiry. */
  incomingRequestTtlMs: 5 * 60 * 1000,

  /** Rate cap for outgoing transfers queued per peer. */
  maxConcurrentTransfers: 3,

  /** Local history retention. */
  historyLimit: 60,

  /** Text limits (defensive; also enforced by the receiver). */
  maxTextLength: 256 * 1024,
} as const;

export type AppConfig = typeof config;
