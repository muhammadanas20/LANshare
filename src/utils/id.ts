/**
 * Cryptographically strong identifiers.
 *
 * `crypto.getRandomValues` / `crypto.randomUUID` are used everywhere. Every supported
 * browser has them (the capability check gates the UI on it), and the non-crypto
 * fallback below never uses `Math.random()` — identifiers must stay unpredictable.
 */

let fallbackCounter = 0;

/** Last-resort entropy for environments without WebCrypto (unreachable in practice). */
function fallbackEntropy(): number {
  fallbackCounter = (fallbackCounter + 1) % Number.MAX_SAFE_INTEGER;
  const now = Date.now();
  const highRes = typeof performance !== 'undefined' ? performance.now() : 0;
  // Mix a monotonic counter with both clocks so repeated calls never repeat an id.
  return (now * 1000 + Math.floor(highRes * 1000) + fallbackCounter * 7919) % Number.MAX_SAFE_INTEGER;
}

function hasCrypto(): boolean {
  return typeof globalThis.crypto?.getRandomValues === 'function';
}

export function secureId(prefix = ''): string {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    const uuid = cryptoObj.randomUUID();
    return prefix ? `${prefix}-${uuid}` : uuid;
  }
  if (hasCrypto()) {
    const bytes = cryptoObj.getRandomValues(new Uint8Array(16));
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    return prefix ? `${prefix}-${hex}` : hex;
  }
  const fallback = fallbackEntropy().toString(36) + fallbackEntropy().toString(36);
  return prefix ? `${prefix}-${fallback}` : fallback;
}

/** Unambiguous room code: no 0/O/1/I/L. ~1.07e9 combinations for 6 chars. */
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function generateRoomCode(length = 6): string {
  const out: string[] = [];
  if (hasCrypto()) {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    for (let i = 0; i < length; i += 1) {
      out.push(ROOM_ALPHABET[(bytes[i] ?? 0) % ROOM_ALPHABET.length] as string);
    }
    return out.join('');
  }
  for (let i = 0; i < length; i += 1) {
    out.push(ROOM_ALPHABET[fallbackEntropy() % ROOM_ALPHABET.length] as string);
  }
  return out.join('');
}

const HEX = 'abcdef0123456789';
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * Random peer id in the style of WebRTC short ids (no dashes, URL/QR friendly).
 * 6 chars ~ 2.2e9 combinations; the server additionally rejects duplicates.
 */
export function randomPeerId(length = 6): string {
  if (hasCrypto()) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length + 1));
    const alphabet = ((bytes[0] as number) & 1) === 0 ? HEX : CHARS;
    return Array.from({ length }, (_, index) => alphabet[(bytes[index + 1] as number) % alphabet.length]).join('');
  }
  return Array.from({ length }, () => CHARS[fallbackEntropy() % CHARS.length]).join('');
}

/** Pick a random index below `size` using crypto when available. */
export function randomIndex(size: number): number {
  if (size <= 0) return 0;
  if (hasCrypto()) {
    const bytes = globalThis.crypto.getRandomValues(new Uint32Array(1));
    return (bytes[0] as number) % size;
  }
  return fallbackEntropy() % size;
}

/** Random float in [0, 1) without `Math.random()` as the entropy source. */
export function randomFraction(): number {
  if (hasCrypto()) {
    const bytes = globalThis.crypto.getRandomValues(new Uint32Array(1));
    return (bytes[0] as number) / 0x1_0000_0000;
  }
  return (fallbackEntropy() % 1_000_000) / 1_000_000;
}
