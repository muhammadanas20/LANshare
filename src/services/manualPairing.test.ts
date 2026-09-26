/**
 * The serverless pairing payload is the only thing in the app that arrives from a human
 * (scanned or pasted) rather than from a validated socket, so it is treated as untrusted
 * input: prefix-tagged, length-capped, inflated with a limit, JSON-parsed, and schema-checked
 * with a *strict* object. These tests pin both halves — the happy path must round-trip
 * exactly, and everything else must be rejected without throwing.
 */
import { deflateSync, strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  MANUAL_MAX_PAYLOAD_CHARS,
  MANUAL_PAYLOAD_PREFIX,
  MANUAL_PAYLOAD_PREFIX_RAW,
  decodeManualPayload,
  encodeManualPayload,
  looksLikeManualPayload,
  waitForIceGatheringComplete,
  type ManualPairingPayload,
} from './manualPairing';

/**
 * A realistic Chrome data-channel offer (the shape and size that actually goes over the wire,
 * ~1.5 KB) — not a minimal hand-written one, because the compression assertion below is about
 * real payloads.
 */
const SDP = [
  'v=0',
  'o=- 4611731400430051336 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0',
  'a=extmap-allow-mixed',
  'a=msid-semantic: WMS',
  'm=application 51000 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 192.168.1.23',
  'a=candidate:1467250027 1 udp 2122260223 192.168.1.23 51000 typ host generation 0 network-id 1 network-cost 10',
  'a=candidate:2998216957 1 udp 1686052607 203.0.113.7 51000 typ srflx raddr 192.168.1.23 rport 51000 generation 0 network-id 1 network-cost 10',
  'a=candidate:1467250027 1 tcp 1518280447 192.168.1.23 9 typ host tcptype active generation 0 network-id 1 network-cost 10',
  'a=ice-ufrag:4ZcD',
  'a=ice-pwd:2/1muC0h5e3oTt0kFhZ1iTMY',
  'a=ice-options:trickle',
  'a=fingerprint:sha-256 5A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9:0A:1B:2C:3D:4E:5F:60:71:82:93:A4:B5:C6:D7:E8:F9',
  'a=setup:actpass',
  'a=mid:0',
  'a=sctp-port:5000',
  'a=max-message-size:262144',
].join('\r\n');

const offer: ManualPairingPayload = {
  v: 1,
  k: 'offer',
  id: 'a1b2c3d4e5',
  n: 'Blue Falcon',
  d: 'desktop',
  sdp: SDP,
};

function raw(payload: unknown): string {
  return MANUAL_PAYLOAD_PREFIX + Buffer.from(deflateSync(strToU8(JSON.stringify(payload)))).toString('base64url');
}

describe('manual pairing payloads', () => {
  it('round-trips an offer exactly', () => {
    const decoded = decodeManualPayload(encodeManualPayload(offer));
    expect(decoded).toEqual(offer);
  });

  it('round-trips an answer, including a device kind of unknown', () => {
    const answer: ManualPairingPayload = { ...offer, k: 'answer', id: 'f6g7h8i9j0', n: 'Quiet Otter', d: 'unknown' };
    expect(decodeManualPayload(encodeManualPayload(answer))).toEqual(answer);
  });

  it('always produces something small enough to render as a QR code', () => {
    const short = encodeManualPayload(offer);
    expect(short.length).toBeLessThan(2_400);

    // A big, busier description (many candidates) must not grow the code without bound.
    const busy: ManualPairingPayload = {
      ...offer,
      sdp: offer.sdp + '\r\n' + Array.from({ length: 6 }, (_, index) =>
        `a=candidate:${900000 + index} 1 udp 212226022${index} 192.168.1.${40 + index} 5100${index} typ host generation 0 network-id 1 network-cost 10`,
      ).join('\r\n'),
    };
    const long = encodeManualPayload(busy);
    expect(long.length).toBeLessThan(busy.sdp.length * 0.85);
    expect(long.length).toBeLessThan(2_400);
  });

  it('keeps the shorter of the two representations instead of always compressing', () => {
    // Measured behaviour: for a small description, deflate + base64 is *larger* than base64 of
    // the raw JSON, so the encoder must not blindly compress — that would inflate the QR code.
    const small = encodeManualPayload(offer);
    const compressed = MANUAL_PAYLOAD_PREFIX + Buffer.from(
      deflateSync(strToU8(JSON.stringify(offer)), { level: 9 }),
    ).toString('base64url');
    const plain = MANUAL_PAYLOAD_PREFIX_RAW + Buffer.from(JSON.stringify(offer)).toString('base64url');
    expect(small.length).toBe(Math.min(compressed.length, plain.length));
    // and the choice is visible in the payload itself, so decoding never has to guess
    expect(small.startsWith(plain.length <= compressed.length ? MANUAL_PAYLOAD_PREFIX_RAW : MANUAL_PAYLOAD_PREFIX)).toBe(true);
  });

  it('decodes both representations', () => {
    const compressed = MANUAL_PAYLOAD_PREFIX + Buffer.from(
      deflateSync(strToU8(JSON.stringify(offer)), { level: 9 }),
    ).toString('base64url');
    const plain = MANUAL_PAYLOAD_PREFIX_RAW + Buffer.from(JSON.stringify(offer)).toString('base64url');
    expect(decodeManualPayload(compressed)).toEqual(offer);
    expect(decodeManualPayload(plain)).toEqual(offer);
  });

  it('tolerates whitespace introduced by copy/paste and chat apps', () => {
    const encoded = encodeManualPayload(offer);
    const wrapped = `${encoded.slice(0, 20)}\n  ${encoded.slice(20, 60)}\r\n${encoded.slice(60)}\n`;
    expect(decodeManualPayload(wrapped)).toEqual(offer);
  });

  it('recognises a payload prefix cheaply, for enabling a button', () => {
    expect(looksLikeManualPayload(encodeManualPayload(offer))).toBe(true);
    expect(looksLikeManualPayload('  LS1.abc  ')).toBe(true);
    expect(looksLikeManualPayload('hello')).toBe(false);
    expect(looksLikeManualPayload('')).toBe(false);
  });

  it('rejects anything that is not a LANShare payload', () => {
    expect(decodeManualPayload('')).toBeNull();
    expect(decodeManualPayload('hello world')).toBeNull();
    expect(decodeManualPayload('https://example.com/?room=ABC123')).toBeNull();
    // Right prefix, but not valid base64url afterwards.
    expect(decodeManualPayload('LS1.!!!not-base64!!!')).toBeNull();
    // Valid base64url that is not zlib data.
    expect(decodeManualPayload('LS1.aGVsbG8gd29ybGQ')).toBeNull();
  });

  it('rejects a payload whose inflated content is not the expected JSON shape', () => {
    expect(decodeManualPayload(raw('not an object'))).toBeNull();
    expect(decodeManualPayload(raw({ v: 2, k: 'offer', id: 'abcdef', n: 'x', sdp: SDP }))).toBeNull();
    expect(decodeManualPayload(raw({ ...offer, k: 'something-else' }))).toBeNull();
    expect(decodeManualPayload(raw({ ...offer, id: 'UPPER CASE' }))).toBeNull();
    expect(decodeManualPayload(raw({ ...offer, sdp: 'too short' }))).toBeNull();
    expect(decodeManualPayload(raw({ ...offer, n: '' }))).toBeNull();
  });

  it('rejects unknown keys instead of forwarding them', () => {
    // A strict schema means a payload cannot smuggle extra data through the pairing channel.
    expect(decodeManualPayload(raw({ ...offer, extra: 'smuggled' }))).toBeNull();
  });

  it('caps how much it will inflate from a hostile payload (no zip bomb)', () => {
    // 2 MB of zeroes compresses to a few KB; the decode must refuse it, not expand it.
    const bomb = MANUAL_PAYLOAD_PREFIX + Buffer.from(deflateSync(new Uint8Array(2 * 1024 * 1024))).toString('base64url');
    expect(decodeManualPayload(bomb)).toBeNull();
  });

  it('refuses absurdly long input without parsing it', () => {
    const huge = MANUAL_PAYLOAD_PREFIX + 'A'.repeat(MANUAL_MAX_PAYLOAD_CHARS);
    expect(decodeManualPayload(huge)).toBeNull();
  });

  it('never throws, whatever it is handed', () => {
    const nasty = ['\u0000', 'LS1.', 'LS1.=', 'LS1..', 'LS1.%%%', '\u{1F600}LS1.abc', 'LS1.' + 'a'.repeat(50)];
    for (const input of nasty) {
      expect(() => decodeManualPayload(input)).not.toThrow();
    }
  });
});

describe('waitForIceGatheringComplete', () => {
  it('resolves immediately when gathering is already complete', async () => {
    const pc = { iceGatheringState: 'complete', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    await expect(waitForIceGatheringComplete(pc as unknown as RTCPeerConnection, 50)).resolves.toBe(true);
    expect(pc.addEventListener).not.toHaveBeenCalled();
  });

  it('resolves when the gathering-state event fires', async () => {
    const handlers: Record<string, () => void> = {};
    const pc = {
      iceGatheringState: 'gathering',
      addEventListener: (type: string, fn: () => void) => {
        handlers[type] = fn;
      },
      removeEventListener: vi.fn(),
    };
    const promise = waitForIceGatheringComplete(pc as unknown as RTCPeerConnection, 1_000);
    pc.iceGatheringState = 'complete';
    handlers.icegatheringstatechange?.();
    await expect(promise).resolves.toBe(true);
    expect(pc.removeEventListener).toHaveBeenCalled();
  });

  it('gives up after the timeout instead of hanging the pairing dialog', async () => {
    const pc = { iceGatheringState: 'gathering', addEventListener: vi.fn(), removeEventListener: vi.fn() };
    await expect(waitForIceGatheringComplete(pc as unknown as RTCPeerConnection, 20)).resolves.toBe(false);
  });
});
