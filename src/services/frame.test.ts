import { describe, expect, it } from 'vitest';
import {
  FRAME_KIND_CHUNK,
  FRAME_KIND_CONTROL,
  FrameDecoder,
  encodeControlFrame,
  encodeFrame,
  type DecodedFrame,
} from './frame';
import type { FrameHeader } from '../types/protocol';
import { config } from '../config';

const encoder = new TextEncoder();

/** Narrow a decoded frame that the test expects to be a data chunk. */
function chunkHeader(frame: DecodedFrame | undefined): FrameHeader {
  if (!frame || frame.kind !== FRAME_KIND_CHUNK) throw new Error('expected a chunk frame');
  return frame.header;
}

describe('frame codec', () => {
  it('round-trips a single frame', () => {
    const payload = encoder.encode('hello LANShare');
    const buffer = encodeFrame({ transferId: 'transfer-1', fileIndex: 0, offset: 0, length: payload.byteLength }, payload);

    const frames = new FrameDecoder().push(buffer);
    expect(frames).toHaveLength(1);
    expect(chunkHeader(frames[0])).toEqual({
      transferId: 'transfer-1',
      fileIndex: 0,
      offset: 0,
      length: payload.byteLength,
    });
    expect(new TextDecoder().decode(frames[0]?.payload)).toBe('hello LANShare');
  });

  it('keeps the announced offset and uses the real payload length', () => {
    const payload = encoder.encode('abc');
    const buffer = encodeFrame({ transferId: 'transfer-2', fileIndex: 3, offset: 64, length: 9999 }, payload);
    const frames = new FrameDecoder().push(buffer);
    expect(chunkHeader(frames[0]).length).toBe(3);
    expect(chunkHeader(frames[0]).offset).toBe(64);
    expect(chunkHeader(frames[0]).fileIndex).toBe(3);
  });

  it('reassembles a frame that arrives split across messages', () => {
    const payload = new Uint8Array(1024).fill(7);
    const buffer = encodeFrame({ transferId: 'transfer-3', fileIndex: 0, offset: 0, length: payload.byteLength }, payload);
    const view = new Uint8Array(buffer);

    const decoder = new FrameDecoder();
    expect(decoder.push(view.subarray(0, 5))).toHaveLength(0);
    expect(decoder.push(view.subarray(5, 100))).toHaveLength(0);
    const frames = decoder.push(view.subarray(100));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.payload.byteLength).toBe(1024);
    expect(frames[0]?.payload[1023]).toBe(7);
  });

  it('handles several frames arriving in one message', () => {
    const a = encoder.encode('aaaa');
    const b = encoder.encode('bbbbbb');
    const bufferA = new Uint8Array(encodeFrame({ transferId: 'transfer-9', fileIndex: 0, offset: 0, length: a.byteLength }, a));
    const bufferB = new Uint8Array(encodeFrame({ transferId: 'transfer-9', fileIndex: 0, offset: 4, length: b.byteLength }, b));
    const joined = new Uint8Array(bufferA.byteLength + bufferB.byteLength);
    joined.set(bufferA, 0);
    joined.set(bufferB, bufferA.byteLength);

    const frames = new FrameDecoder().push(joined);
    expect(frames).toHaveLength(2);
    expect(chunkHeader(frames[1]).offset).toBe(4);
    expect(new TextDecoder().decode(frames[1]?.payload)).toBe('bbbbbb');
  });

  it('round-trips an in-band control frame', () => {
    const frames = new FrameDecoder().push(
      encodeControlFrame({ t: 'FILE_END', transferId: 'transfer-7', fileIndex: 2, bytes: 4096, sha256: 'ab' }),
    );
    expect(frames).toHaveLength(1);
    const frame = frames[0];
    expect(frame?.kind).toBe(FRAME_KIND_CONTROL);
    expect(frame?.header).toEqual({
      t: 'FILE_END',
      transferId: 'transfer-7',
      fileIndex: 2,
      bytes: 4096,
      sha256: 'ab',
    });
  });

  it('keeps control and data frames in arrival order within one message', () => {
    const payload = encoder.encode('tail bytes');
    const chunk = new Uint8Array(encodeFrame({ transferId: 'transfer-8', fileIndex: 0, offset: 0, length: payload.byteLength }, payload));
    const control = new Uint8Array(encodeControlFrame({ t: 'TRANSFER_DONE', transferId: 'transfer-8', bytes: payload.byteLength }));
    const joined = new Uint8Array(chunk.byteLength + control.byteLength);
    joined.set(chunk, 0);
    joined.set(control, chunk.byteLength);

    const frames = new FrameDecoder().push(joined);
    expect(frames.map((frame) => frame.kind)).toEqual([FRAME_KIND_CHUNK, FRAME_KIND_CONTROL]);
    expect(frames[1]?.header).toMatchObject({ t: 'TRANSFER_DONE', bytes: payload.byteLength });
  });

  it('rejects a control frame with an unknown type', () => {
    const decoder = new FrameDecoder();
    const header = encoder.encode(JSON.stringify({ t: 'NOPE', transferId: 'x' }));
    const buffer = new Uint8Array(3 + header.byteLength);
    buffer[0] = FRAME_KIND_CONTROL;
    buffer[1] = 0;
    buffer[2] = header.byteLength;
    buffer.set(header, 3);
    expect(() => decoder.push(buffer)).toThrow(/Malformed control frame/);
  });

  it('waits when a frame has only partially arrived', () => {
    const decoder = new FrameDecoder();
    expect(decoder.push(new Uint8Array([FRAME_KIND_CHUNK, 0, 20, 123, 125, 1, 2, 3]))).toHaveLength(0);
  });

  it('rejects a malformed header', () => {
    const decoder = new FrameDecoder();
    const garbage = new Uint8Array([FRAME_KIND_CHUNK, 0, 5, ...encoder.encode('notjs'), 1]);
    expect(() => decoder.push(garbage)).toThrow(/Malformed frame header/);
  });

  it('rejects a zero-length header prefix (desynchronised stream)', () => {
    expect(() => new FrameDecoder().push(new Uint8Array([FRAME_KIND_CHUNK, 0, 0, 1, 2, 3]))).toThrow(/Malformed frame header/);
  });

  it('rejects a frame whose transfer id is not a valid id', () => {
    const payload = encoder.encode('x');
    const buffer = encodeFrame({ transferId: 't', fileIndex: 0, offset: 0, length: 1 }, payload);
    expect(() => new FrameDecoder().push(buffer)).toThrow(/Malformed frame header/);
  });

  it('rejects a payload larger than the configured maximum', () => {
    const payload = encoder.encode('tiny');
    const buffer = encodeFrame({ transferId: 'transfer-9', fileIndex: 0, offset: 0, length: payload.byteLength }, payload);
    const view = new Uint8Array(buffer);
    const headerLength = ((view[1] as number) << 8) | (view[2] as number);
    const header = JSON.parse(new TextDecoder().decode(view.subarray(3, 3 + headerLength)));
    // Within the schema's own guard, but far beyond this decoder's frame limit.
    header.length = 4 * 1024 * 1024;
    const replaced = encoder.encode(JSON.stringify(header));
    const patched = new Uint8Array(3 + replaced.byteLength + payload.byteLength);
    patched[0] = FRAME_KIND_CHUNK;
    patched[1] = (replaced.byteLength >> 8) & 0xff;
    patched[2] = replaced.byteLength & 0xff;
    patched.set(replaced, 3);
    patched.set(payload, 3 + replaced.byteLength);

    expect(() => new FrameDecoder(config.chunkSize * 4).push(patched)).toThrow(/maximum chunk size/);
  });
});
