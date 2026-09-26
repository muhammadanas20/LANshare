import { describe, expect, it } from 'vitest';
import { parsePeerMessage, parseServerMessage, PeerMessageSchema, ServerMessageSchema } from './protocol';

describe('server message validation', () => {
  it('accepts a well-formed WELCOME', () => {
    const parsed = parseServerMessage({
      type: 'WELCOME',
      selfId: 'abc123',
      roomId: 'ROOM01',
      name: 'Blue Falcon',
      peers: [{ id: 'def456', name: 'Silent Panda', device: 'mobile', joinedAt: 1 }],
      limits: { maxPeers: 8, maxMessageBytes: 65536, serverTime: Date.now() },
    });
    expect(parsed?.type).toBe('WELCOME');
  });

  it('rejects unknown message types', () => {
    expect(parseServerMessage({ type: 'EXECUTE', payload: 'rm -rf /' })).toBeNull();
  });

  it('rejects room ids with unsafe characters', () => {
    expect(parseServerMessage({ type: 'WELCOME', selfId: 'a', roomId: '../etc', name: 'x', peers: [] })).toBeNull();
  });

  it('rejects oversized SDP payloads', () => {
    const result = ServerMessageSchema.safeParse({
      type: 'SIGNAL',
      from: 'peer',
      data: { kind: 'offer', sdp: 'a'.repeat(40 * 1024) },
    });
    expect(result.success).toBe(false);
  });

  it('rejects names that are empty after trimming', () => {
    expect(parseServerMessage({ type: 'PEER_JOINED', peer: { id: 'x', name: '   ', device: 'desktop', joinedAt: 1 } })).toBeNull();
  });
});

describe('peer message validation', () => {
  it('accepts a transfer request', () => {
    const parsed = parsePeerMessage({
      t: 'TRANSFER_REQUEST',
      transferId: 'transfer-abcdef',
      kind: 'files',
      items: [{ id: 'q1', name: 'photo.jpg', size: 4_200_000, mime: 'image/jpeg' }],
      totalSize: 4_200_000,
      createdAt: Date.now(),
    });
    expect(parsed?.t).toBe('TRANSFER_REQUEST');
  });

  it('rejects an unknown protocol message', () => {
    expect(parsePeerMessage({ t: 'RUN_SCRIPT', code: 'alert(1)' })).toBeNull();
  });

  it('rejects a transfer request with an excessive item count', () => {
    const items = Array.from({ length: 400 }, (_, index) => ({
      id: `q${index}`,
      name: `f${index}`,
      size: 1,
      mime: 'text/plain',
    }));
    const result = PeerMessageSchema.safeParse({
      t: 'TRANSFER_REQUEST',
      transferId: 'transfer-1',
      kind: 'files',
      items,
      totalSize: 400,
      createdAt: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects a negative or non-integer size', () => {
    const base = { t: 'TRANSFER_REQUEST', transferId: 'transfer-1', kind: 'files', createdAt: Date.now() } as const;
    expect(
      PeerMessageSchema.safeParse({ ...base, items: [{ id: 'q', name: 'a', size: -1, mime: 'text/plain' }], totalSize: -1 })
        .success,
    ).toBe(false);
    expect(
      PeerMessageSchema.safeParse({ ...base, items: [{ id: 'q', name: 'a', size: 1.5, mime: 'text/plain' }], totalSize: 1 })
        .success,
    ).toBe(false);
  });

  it('rejects oversized text payloads', () => {
    const result = PeerMessageSchema.safeParse({
      t: 'TRANSFER_REQUEST',
      transferId: 'transfer-1',
      kind: 'text',
      items: [],
      totalSize: 0,
      text: 'x'.repeat(300 * 1024),
      createdAt: Date.now(),
    });
    expect(result.success).toBe(false);
  });

  it('validates binary frame headers', () => {
    expect(
      PeerMessageSchema.safeParse({ t: 'FILE_CHUNK', transferId: 'x' }).success,
    ).toBe(false);
  });

  it('accepts ping/pong and flow control messages', () => {
    expect(parsePeerMessage({ t: 'PING', id: 1, at: 2 })?.t).toBe('PING');
    expect(parsePeerMessage({ t: 'FLOW', transferId: 'transfer-1', paused: true })?.t).toBe('FLOW');
  });
});
