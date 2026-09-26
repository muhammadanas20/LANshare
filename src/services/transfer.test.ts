import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TransferManager } from './transfer';
import { encodeControlFrame } from './frame';
import type { FrameControl, PeerMessage } from '../types/protocol';
import type { QueuedFile } from '../types/transfer';

/**
 * In-memory peer link. Control messages are delivered asynchronously (like a real
 * data channel) and binary frames synchronously, which is exactly how the production
 * code paths behave — so this exercises the true protocol implementation.
 */
class LoopbackPeer {
  peer: LoopbackPeer | null = null;
  manager: TransferManager | null = null;
  sentBinary = 0;
  sentBytes = 0;
  offline = false;
  /** Extra latency applied to the *control* channel, to emulate two SCTP streams. */
  controlDelayTicks = 0;

  sendControl(_peerId: string, message: PeerMessage): boolean {
    if (this.offline || !this.peer?.manager) return false;
    const target = this.peer;
    const deliver = () => target.manager?.handleMessage('loopback', message);
    if (this.controlDelayTicks > 0) {
      let remaining = this.controlDelayTicks;
      const step = () => {
        remaining -= 1;
        if (remaining <= 0) deliver();
        else setTimeout(step, 0);
      };
      setTimeout(step, 0);
    } else {
      queueMicrotask(deliver);
    }
    return true;
  }

  /**
   * In-band control travels on the data channel, so it is delivered on the same
   * queue as the payload — exactly like `bin` on a real RTCPeerConnection.
   */
  sendInBand(_peerId: string, message: FrameControl): boolean {
    if (this.offline || !this.peer?.manager) return false;
    this.peer.manager.handleBinary('loopback', encodeControlFrame(message));
    return true;
  }

  sendBinary(_peerId: string, payload: ArrayBuffer): boolean {
    if (this.offline || !this.peer?.manager) return false;
    this.sentBinary += 1;
    this.sentBytes += payload.byteLength;
    this.peer.manager.handleBinary('loopback', payload);
    return true;
  }

  bufferedAmount(): number {
    return 0;
  }

  async waitForDrain(): Promise<boolean> {
    return true;
  }
}

interface Harness {
  sender: TransferManager;
  receiver: TransferManager;
  senderLink: LoopbackPeer;
  receiverLink: LoopbackPeer;
  senderEvents: ReturnType<typeof createEvents>;
  receiverEvents: ReturnType<typeof createEvents>;
}

function createEvents() {
  return {
    onIncomingRequest: vi.fn(),
    onIncomingResolved: vi.fn(),
    onUpdate: vi.fn(),
    onNotice: vi.fn(),
    onHistory: vi.fn(),
    onSavedToDisk: vi.fn(),
  };
}

function createHarness(): Harness {
  const senderLink = new LoopbackPeer();
  const receiverLink = new LoopbackPeer();
  senderLink.peer = receiverLink;
  receiverLink.peer = senderLink;

  const senderEvents = createEvents();
  const receiverEvents = createEvents();

  const sender = new TransferManager({
    peers: senderLink as never,
    events: senderEvents,
    getPeerName: () => 'Silent Panda',
    getReceiveDirectory: () => null,
  });
  const receiver = new TransferManager({
    peers: receiverLink as never,
    events: receiverEvents,
    getPeerName: () => 'Blue Falcon',
    getReceiveDirectory: () => null,
  });

  senderLink.manager = sender;
  receiverLink.manager = receiver;

  return { sender, receiver, senderLink, receiverLink, senderEvents, receiverEvents };
}

function queuedFile(name: string, bytes: Uint8Array, mime = 'application/octet-stream'): QueuedFile {
  const file = new File([bytes as unknown as BlobPart], name, { type: mime });
  return { id: `q-${name}`, file, name, size: file.size, mime };
}

async function tick(times = 8): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function waitFor(predicate: () => boolean, timeout = 4000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for the transfer to settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('TransferManager', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = createHarness();
  });

  it('sends a file end to end once the receiver accepts', async () => {
    const payload = new Uint8Array(200_000);
    for (let index = 0; index < payload.length; index += 1) payload[index] = index % 251;

    const transferId = harness.sender.send({
      peerId: 'peer-b',
      kind: 'files',
      files: [queuedFile('photo.png', payload, 'image/png')],
    });
    expect(transferId).toBeTruthy();

    await tick();
    // Request arrived and is awaiting consent — nothing has been written yet.
    expect(harness.receiverEvents.onIncomingRequest).toHaveBeenCalledTimes(1);
    const request = harness.receiverEvents.onIncomingRequest.mock.calls[0]?.[0];
    expect(request.items[0].name).toBe('photo.png');
    expect(request.totalSize).toBe(payload.byteLength);

    await harness.receiver.acceptIncoming(transferId as string);
    await waitFor(() => {
      const latest = harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0];
      return latest?.id === transferId && latest.status === 'completed';
    });

    const receivedCall = harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(receivedCall.status).toBe('completed');
    expect(receivedCall.totalBytes).toBe(payload.byteLength);

    const file = receivedCall.received[0];
    expect(file.name).toBe('photo.png');
    expect(file.size).toBe(payload.byteLength);
    const bytes = new Uint8Array(await file.blob.arrayBuffer());
    expect(bytes.length).toBe(payload.byteLength);
    expect(bytes[12345]).toBe(12345 % 251);

    // Chunked, never one huge frame.
    expect(harness.senderLink.sentBinary).toBeGreaterThan(1);
    // Receiver reports history for the completed transfer.
    expect(harness.receiverEvents.onHistory).toHaveBeenCalledWith(
      expect.objectContaining({ direction: 'receiving', status: 'completed', fileCount: 1 }),
      true,
    );
  });

  it('transfers multiple files in order', async () => {
    const files = [
      queuedFile('a.txt', new Uint8Array([1, 1, 1]), 'text/plain'),
      queuedFile('b.txt', new Uint8Array([2, 2, 2, 2]), 'text/plain'),
      queuedFile('c.bin', new Uint8Array([3, 3]), 'application/octet-stream'),
    ];
    const transferId = harness.sender.send({ peerId: 'peer-b', kind: 'files', files }) as string;
    await tick();
    await harness.receiver.acceptIncoming(transferId);
    await waitFor(() => harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'completed');

    const record = harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(record.received.map((file: { name: string }) => file.name)).toEqual(['a.txt', 'b.txt', 'c.bin']);
    const last = await record.received[2].blob.arrayBuffer();
    expect(new Uint8Array(last)).toEqual(new Uint8Array([3, 3]));
  });

  it('reports rejection back to the sender', async () => {
    const transferId = harness.sender.send({
      peerId: 'peer-b',
      kind: 'files',
      files: [queuedFile('x.bin', new Uint8Array(10))],
    }) as string;
    await tick();
    harness.receiver.rejectIncoming(transferId, 'declined');
    await waitFor(() => harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'rejected');

    const record = harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(record.error).toMatch(/declined/i);
    expect(harness.senderEvents.onNotice).toHaveBeenCalled();
  });

  it('cancels an in-flight transfer from the sender and tells the receiver', async () => {
    const big = new Uint8Array(4 * 1024 * 1024);
    const transferId = harness.sender.send({
      peerId: 'peer-b',
      kind: 'files',
      files: [queuedFile('large.bin', big)],
    }) as string;
    await tick();
    await harness.receiver.acceptIncoming(transferId);
    await tick(2);
    harness.sender.cancel(transferId);
    await waitFor(() => harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'cancelled');

    const senderRecord = harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(senderRecord.status).toBe('cancelled');
    const receiverRecord = harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(receiverRecord.status).toBe('cancelled');
  });

  it('sends text and completes on acceptance', async () => {
    const transferId = harness.sender.send({ peerId: 'peer-b', kind: 'text', text: 'https://example.com' }) as string;
    await tick();
    const request = harness.receiverEvents.onIncomingRequest.mock.calls[0]?.[0];
    expect(request.kind).toBe('text');
    expect(request.text).toBe('https://example.com');

    await harness.receiver.acceptIncoming(transferId);
    await waitFor(() => harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'completed');
    expect(harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0].text).toBe('https://example.com');
    await waitFor(() => harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'completed');
  });

  it('completes even when the control channel lags behind the data channel', async () => {
    // Regression test: `ctl` and `bin` are separate SCTP streams, so a completion
    // marker on `ctl` used to be able to overtake the last chunks on `bin` and fail
    // a transfer that had actually delivered every byte.
    harness.senderLink.controlDelayTicks = 8;

    const payload = new Uint8Array(300_000).fill(9);
    const transferId = harness.sender.send({
      peerId: 'peer-b',
      kind: 'files',
      files: [queuedFile('laggy.bin', payload)],
    }) as string;

    await waitFor(() => harness.receiverEvents.onIncomingRequest.mock.calls.length > 0);
    await harness.receiver.acceptIncoming(transferId);

    await waitFor(() => harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'completed');
    const received = harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(received.received).toHaveLength(1);
    expect(received.received[0].size).toBe(payload.byteLength);
    expect(received.received[0].blob?.size).toBe(payload.byteLength);
    await waitFor(() => harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'completed');
  });

  it('waits for the async assembly of the last file before completing', async () => {
    // The FILE_END marker of a 400 kB file is delivered immediately, but hashing the
    // blob resolves later — completion must not be declared in between.
    const files = [
      queuedFile('one.bin', new Uint8Array(400_000).fill(1)),
      queuedFile('two.bin', new Uint8Array(400_000).fill(2)),
    ];
    const transferId = harness.sender.send({ peerId: 'peer-b', kind: 'files', files }) as string;
    await waitFor(() => harness.receiverEvents.onIncomingRequest.mock.calls.length > 0);
    await harness.receiver.acceptIncoming(transferId);

    await waitFor(() => harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'completed');
    const record = harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(record.received).toHaveLength(2);
    expect(record.received.map((item: { name: string }) => item.name)).toEqual(['one.bin', 'two.bin']);
    expect(record.received.every((item: { size: number }) => item.size === 400_000)).toBe(true);
    expect(record.totalBytes).toBe(800_000);
  });

  it('fails the transfer when the payload does not match the announced size', async () => {
    const file = queuedFile('short.bin', new Uint8Array(100));
    const transferId = harness.sender.send({ peerId: 'peer-b', kind: 'files', files: [file] }) as string;
    await tick();
    await harness.receiver.acceptIncoming(transferId);
    await tick(2);

    // Simulate a lying peer: announce a larger size than the bytes that follow.
    harness.receiver.handleBinary(
      'loopback',
      encodeControlFrame({ t: 'FILE_START', transferId, fileIndex: 0, size: 100 }),
    );
    harness.receiver.handleBinary(
      'loopback',
      // mismatch with the bytes actually buffered
      encodeControlFrame({ t: 'FILE_END', transferId, fileIndex: 0, bytes: 40 }),
    );
    await waitFor(() => harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'failed');
    const record = harness.receiverEvents.onUpdate.mock.calls.at(-1)?.[0];
    expect(record.error).toMatch(/completely|size/i);
  });

  it('ignores frames for transfers it never accepted', () => {
    const junk = new Uint8Array([0, 20, 123, 125]).buffer;
    expect(() => harness.receiver.handleBinary('unknown-peer', junk)).not.toThrow();
    expect(harness.receiverEvents.onNotice).not.toHaveBeenCalled();
  });

  it('fails outbound transfers when the peer disappears', async () => {
    const transferId = harness.sender.send({
      peerId: 'peer-b',
      kind: 'files',
      files: [queuedFile('a.bin', new Uint8Array(32))],
    }) as string;
    await tick();
    harness.sender.handlePeerGone('peer-b');
    await waitFor(() => harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'failed');
    expect(harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0].error).toMatch(/disconnected/);
    expect(transferId).toBeTruthy();
  });

  it('does not count finished transfers against the concurrency limit', async () => {
    // Regression: completed records linger for a minute, and used to make every
    // later send fail once a few transfers had run.
    for (let index = 0; index < 4; index += 1) {
      const transferId = harness.sender.send({
        peerId: 'peer-b',
        kind: 'files',
        files: [queuedFile(`small-${index}.bin`, new Uint8Array(64))],
      }) as string;
      await waitFor(() => harness.receiverEvents.onIncomingRequest.mock.calls.length > index);
      await harness.receiver.acceptIncoming(transferId);
      await waitFor(() => harness.senderEvents.onUpdate.mock.calls.at(-1)?.[0]?.status === 'completed');
    }
    const extra = harness.sender.send({
      peerId: 'peer-b',
      kind: 'files',
      files: [queuedFile('after.bin', new Uint8Array(64))],
    });
    expect(extra).toBeTruthy();
    expect(harness.senderEvents.onNotice).not.toHaveBeenCalledWith(
      'warning',
      expect.stringContaining('Too many transfers'),
    );
  });

  it('refuses to queue more than the concurrent transfer limit', () => {
    const file = queuedFile('a.bin', new Uint8Array(16));
    const ids = [
      harness.sender.send({ peerId: 'p', kind: 'files', files: [file] }),
      harness.sender.send({ peerId: 'p', kind: 'files', files: [file] }),
      harness.sender.send({ peerId: 'p', kind: 'files', files: [file] }),
    ];
    expect(ids.filter(Boolean)).toHaveLength(3);
    const extra = harness.sender.send({ peerId: 'p', kind: 'files', files: [file] });
    expect(extra).toBeNull();
    expect(harness.senderEvents.onNotice).toHaveBeenCalledWith('warning', expect.stringMatching(/already running/));
  });
});
