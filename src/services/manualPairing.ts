/**
 * Serverless pairing — the offer/answer exchange for two devices that have **no signaling
 * server at all** (no Node on the computer, two phones, no router, no internet).
 *
 * WebRTC can connect two peers on the same network with nothing but host candidates, but the
 * two session descriptions still have to travel between the devices. When there is no server
 * to carry them, the user carries them: the invite is a short, compressed text payload that
 * can be shown as a QR code, pasted into a chat, or typed on the other device.
 *
 * Everything here is defensive because the payload arrives from a human: it is length-capped,
 * prefix-tagged, zlib-inflated with a hard output limit, JSON-parsed, and then validated with
 * a strict schema (unknown keys are rejected). A malformed or hostile payload is simply
 * rejected — it never reaches a peer connection.
 */
import { deflateSync, inflateSync, strFromU8, strToU8 } from 'fflate';
import { z } from 'zod';

/** Tag so a payload is recognisable (and rejectable) before any parsing happens. */
export const MANUAL_PAYLOAD_PREFIX = 'LS1.';
/**
 * Uncompressed variant. Measured, not guessed: deflate plus base64 expansion is *larger* than
 * the raw description for a small SDP (a data-channel offer can be under 1 KB), and smaller
 * only once the description grows. The encoder therefore produces both and keeps the shorter
 * one, which keeps the QR code as sparse (and as scannable) as possible.
 */
export const MANUAL_PAYLOAD_PREFIX_RAW = 'LS1J.';

/** Hard cap on what we will even attempt to decode (a session description is ~1–4 KB). */
export const MANUAL_MAX_PAYLOAD_CHARS = 12_000;
const MANUAL_MAX_INFLATED_CHARS = 64_000;

export const ManualPairingPayloadSchema = z
  .object({
    v: z.literal(1),
    /** Which half of the handshake this is. */
    k: z.enum(['offer', 'answer']),
    /** The sender's own peer id (random, local, non-identifying). */
    id: z
      .string()
      .min(6)
      .max(32)
      .regex(/^[a-z0-9]+$/),
    /** Friendly display name, shown while the channel is still opening. */
    n: z.string().trim().min(1).max(32),
    d: z.enum(['desktop', 'mobile', 'tablet', 'unknown']).default('unknown'),
    /** The session description. Bounded well above a real SDP, far below anything abusive. */
    sdp: z.string().min(20).max(20_000),
  })
  .strict();

export type ManualPairingPayload = z.infer<typeof ManualPairingPayloadSchema>;

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  // Chunked so a large payload cannot blow the argument limit of String.fromCharCode.
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const withPadding = padded + '='.repeat((4 - (padded.length % 4)) % 4);
  try {
    const binary = atob(withPadding);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** Serialise a handshake payload into the short text a user can move between devices. */
export function encodeManualPayload(payload: ManualPairingPayload): string {
  const validated = ManualPairingPayloadSchema.parse(payload);
  const json = strToU8(JSON.stringify(validated));
  const compressed = MANUAL_PAYLOAD_PREFIX + toBase64Url(deflateSync(json, { level: 9 }));
  const plain = MANUAL_PAYLOAD_PREFIX_RAW + toBase64Url(json);
  return compressed.length <= plain.length ? compressed : plain;
}

/**
 * Parse a payload that a human pasted or scanned. Returns `null` for anything that is not a
 * valid LANShare payload — never throws, never partially applies.
 */
export function decodeManualPayload(text: string): ManualPairingPayload | null {
  const trimmed = text.trim().replace(/\s+/g, '');
  if (trimmed.length > MANUAL_MAX_PAYLOAD_CHARS) return null;

  const uncompressed = trimmed.startsWith(MANUAL_PAYLOAD_PREFIX_RAW);
  const prefixLength = uncompressed ? MANUAL_PAYLOAD_PREFIX_RAW.length : MANUAL_PAYLOAD_PREFIX.length;
  if (!uncompressed && !trimmed.startsWith(MANUAL_PAYLOAD_PREFIX)) return null;

  const bytes = fromBase64Url(trimmed.slice(prefixLength));
  if (!bytes) return null;

  let json: string;
  try {
    if (uncompressed) {
      if (bytes.length > MANUAL_MAX_INFLATED_CHARS) return null;
      json = strFromU8(bytes);
    } else {
      // `inflateSync` on hostile input can expand enormously; cap what we keep.
      const inflated = inflateSync(bytes);
      if (inflated.length > MANUAL_MAX_INFLATED_CHARS) return null;
      json = strFromU8(inflated);
    }
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const result = ManualPairingPayloadSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Cheap check used by the UI to enable/disable a "Connect" button as the user pastes. */
export function looksLikeManualPayload(text: string): boolean {
  const trimmed = text.trim().replace(/\s+/g, '');
  return trimmed.startsWith(MANUAL_PAYLOAD_PREFIX) || trimmed.startsWith(MANUAL_PAYLOAD_PREFIX_RAW);
}

/**
 * Wait until ICE has finished gathering, so the serialised description is self-contained.
 *
 * The manual flow cannot trickle candidates (there is no channel to trickle over), so the
 * session description must be complete before it is shown. Manual links use host candidates
 * only, so this normally resolves in a few milliseconds.
 */
export function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<boolean> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (complete: boolean) => {
      pc.removeEventListener('icegatheringstatechange', onChange);
      clearTimeout(timer);
      resolve(complete);
    };
    const onChange = () => {
      if (pc.iceGatheringState === 'complete') finish(true);
    };
    const timer = setTimeout(() => finish(pc.iceGatheringState === 'complete'), timeoutMs);
    pc.addEventListener('icegatheringstatechange', onChange);
  });
}
