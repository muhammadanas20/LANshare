/**
 * Binary frame codec for the `bin` data channel.
 *
 * Layout: [1-byte kind][2-byte big-endian header length][UTF-8 JSON][optional payload]
 *
 *   kind 0 (chunk)   header = { transferId, fileIndex, offset, length } + payload bytes
 *   kind 1 (control) header = in-band control message, e.g. { t: 'FILE_END', … }
 *
 * In-band control is not a nicety: the `ctl` and `bin` channels are separate SCTP
 * streams, so a `FILE_END` on `ctl` can overtake the chunks still queued on `bin`.
 * Per-file markers therefore travel on the same stream as the file data, which
 * guarantees they are only seen after every byte of that file has been delivered.
 */
import { FrameControlSchema, FrameHeaderSchema, type FrameControl, type FrameHeader } from '../types/protocol';

export const FRAME_KIND_CHUNK = 0;
export const FRAME_KIND_CONTROL = 1;

export type DecodedFrame =
  | { kind: typeof FRAME_KIND_CHUNK; header: FrameHeader; payload: Uint8Array }
  | { kind: typeof FRAME_KIND_CONTROL; header: FrameControl; payload: Uint8Array };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function packFrame(kind: number, headerBytes: Uint8Array, payload: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(3 + headerBytes.byteLength + payload.byteLength);
  const view = new Uint8Array(buffer);
  view[0] = kind;
  view[1] = (headerBytes.byteLength >> 8) & 0xff;
  view[2] = headerBytes.byteLength & 0xff;
  view.set(headerBytes, 3);
  view.set(payload, 3 + headerBytes.byteLength);
  return buffer;
}

/** A data frame carrying one chunk of file bytes. */
export function encodeFrame(header: FrameHeader, payload: Uint8Array): ArrayBuffer {
  const headerJson = JSON.stringify({
    transferId: header.transferId,
    fileIndex: header.fileIndex,
    offset: header.offset,
    length: payload.byteLength,
  });
  const headerBytes = encoder.encode(headerJson);
  if (headerBytes.byteLength > 0xffff) throw new Error('Frame header too large');
  return packFrame(FRAME_KIND_CHUNK, headerBytes, payload);
}

/** An in-band control frame (no payload) sent on the data channel. */
export function encodeControlFrame(message: FrameControl): ArrayBuffer {
  const headerBytes = encoder.encode(JSON.stringify(message));
  if (headerBytes.byteLength > 0xffff) throw new Error('Control frame too large');
  return packFrame(FRAME_KIND_CONTROL, headerBytes, new Uint8Array(0));
}

/**
 * Reassembles frames from arbitrarily split binary messages.
 * A malformed stream fails loudly rather than producing corrupt files.
 */
export class FrameDecoder {
  private pending: Uint8Array | null = null;
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes = 8 * 1024 * 1024) {
    this.maxFrameBytes = maxFrameBytes;
  }

  reset(): void {
    this.pending = null;
  }

  push(chunk: ArrayBuffer | Uint8Array): DecodedFrame[] {
    const incoming = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    let data: Uint8Array;
    if (this.pending && this.pending.byteLength > 0) {
      data = new Uint8Array(this.pending.byteLength + incoming.byteLength);
      data.set(this.pending, 0);
      data.set(incoming, this.pending.byteLength);
      this.pending = null;
    } else {
      data = incoming;
    }

    const frames: DecodedFrame[] = [];
    let offset = 0;

    while (data.byteLength - offset >= 3) {
      const kind = data[offset] as number;
      const headerLength = ((data[offset + 1] as number) << 8) | (data[offset + 2] as number);
      if ((kind !== FRAME_KIND_CHUNK && kind !== FRAME_KIND_CONTROL) || headerLength === 0 || headerLength > 4096) {
        this.pending = null;
        throw new Error('Malformed frame header');
      }
      const frameStart = offset + 3;
      if (data.byteLength - frameStart < headerLength) break;

      let parsedHeader: unknown = null;
      try {
        parsedHeader = JSON.parse(decoder.decode(data.subarray(frameStart, frameStart + headerLength)));
      } catch {
        parsedHeader = null;
      }

      if (kind === FRAME_KIND_CONTROL) {
        const control = FrameControlSchema.safeParse(parsedHeader);
        if (!control.success) {
          this.pending = null;
          throw new Error('Malformed control frame');
        }
        frames.push({ kind: FRAME_KIND_CONTROL, header: control.data, payload: new Uint8Array(0) });
        offset = frameStart + headerLength;
        continue;
      }

      const header = FrameHeaderSchema.safeParse(parsedHeader);
      if (!header.success) {
        this.pending = null;
        throw new Error('Malformed frame header');
      }
      if (header.data.length > this.maxFrameBytes) {
        this.pending = null;
        throw new Error('Frame exceeds the maximum chunk size');
      }

      const payloadStart = frameStart + headerLength;
      const payloadEnd = payloadStart + header.data.length;
      if (data.byteLength < payloadEnd) break;

      frames.push({ kind: FRAME_KIND_CHUNK, header: header.data, payload: data.subarray(payloadStart, payloadEnd) });
      offset = payloadEnd;
    }

    if (offset < data.byteLength) {
      // Keep the tail for the next push (copy so we do not pin the whole buffer).
      this.pending = data.slice(offset);
    } else {
      this.pending = null;
    }

    return frames;
  }
}
