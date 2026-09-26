/**
 * Transfer manager.
 *
 * Outbound: splits files with `Blob.slice()`, throttles with `bufferedAmount`
 * backpressure, and streams frames over the `bin` data channel.
 * Inbound: validates every frame against an *accepted* transfer, reassembles the
 * file (memory Blob or streamed straight to disk), and reports live progress.
 *
 * The signaling server is never involved in any of this.
 */
import { config } from '../config';
import type { FrameControl, PeerMessage, TransferItem } from '../types/protocol';
import type { HistoryEntry, IncomingRequest, QueuedFile, TransferRecord } from '../types/transfer';
import { buildSaveName } from './file';
import { FRAME_KIND_CONTROL, FrameDecoder, encodeFrame } from './frame';
import { log } from './logger';
import type { LinkIdentity, PeerManager } from './webrtc';
import { secureId } from '../utils/id';
import { SpeedMeter } from '../utils/speed';
import { safeMime, sanitizeFilename } from '../utils/validation';

export type NoticeLevel = 'success' | 'error' | 'warning' | 'info';

export interface TransferEvents {
  /** An inbound TRANSFER_REQUEST is waiting for a decision. */
  onIncomingRequest: (request: IncomingRequest) => void;
  onIncomingResolved: (transferId: string, status: 'accepted' | 'rejected' | 'expired') => void;
  onUpdate: (record: TransferRecord) => void;
  onNotice: (level: NoticeLevel, message: string) => void;
  onHistory: (entry: HistoryEntry, remember: boolean) => void;
  /** Receiver streamed data straight to a user-chosen folder. */
  onSavedToDisk: (record: TransferRecord, folderName: string) => void;
}

export interface TransferManagerOptions {
  peers: PeerManager;
  events: TransferEvents;
  getPeerName: (peerId: string) => string;
  /** Directory chosen by the user for direct-to-disk receiving (Chromium). */
  getReceiveDirectory?: () => FileSystemDirectoryHandle | null;
  getAutoDownload?: () => boolean;
}

interface OutboundState {
  record: TransferRecord;
  files: QueuedFile[];
  cancelled: boolean;
  pausedUntil: number;
  meter: SpeedMeter;
  lastEmit: number;
  sentBytes: number;
  /** Raw counters used by the debug log line below. */
  framesSent: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface InboundFileState {
  index: number;
  item: TransferItem;
  chunks: Blob[] | null;
  writer: FileSystemWritableFileStream | null;
  savedName: string;
  received: number;
  streamed: boolean;
}

interface InboundState {
  /** Raw counters used by the debug log line below. */
  framesReceived: number;
  /** `FILE_END` markers seen (counted before assembly, which is asynchronous). */
  endsSeen: number;
  /** The sender signalled that it has finished the whole transfer. */
  senderDone: boolean;
  record: TransferRecord;
  files: InboundFileState[];
  current: InboundFileState | null;
  paused: boolean;
  meter: SpeedMeter;
  lastEmit: number;
  writeQueueDepth: number;
  writeQueueBytes: number;
  bytesSinceFlowCheck: number;
  flowPausedSent: boolean;
  cancelled: boolean;
}

const PROGRESS_EMIT_MS = 120;
const HASH_LIMIT_BYTES = 16 * 1024 * 1024;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(blob: Blob): Promise<string | null> {
  try {
    if (blob.size > HASH_LIMIT_BYTES) return null;
    const buffer = await blob.arrayBuffer();
    if (!globalThis.crypto?.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    return toHex(digest);
  } catch {
    return null;
  }
}

export class TransferManager {
  private outbound = new Map<string, OutboundState>();
  private inbound = new Map<string, InboundState>();
  /**
   * One decoder per peer, not per transfer: the `bin` channel is a single ordered
   * stream and every frame carries its own transfer id. Keying this by transfer
   * made a lingering finished transfer swallow the bytes of the next one.
   */
  private decoders = new Map<string, FrameDecoder>();
  private pendingRequests = new Map<string, IncomingRequest>();
  private requestTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly options: TransferManagerOptions) {}

  /* ------------------------------------------------------------------ *
   * Outbound
   * ------------------------------------------------------------------ */

  /**
   * Queue a transfer. Resolves as soon as the request is on the wire — the actual
   * byte stream starts when the receiver accepts.
   */
  send(options: { peerId: string; kind: 'files' | 'text'; files?: QueuedFile[]; text?: string }): string | null {
    if (this.disposed) return null;
    const { peerId, kind } = options;
    const files = options.files ?? [];
    const text = options.text ?? '';

    if (kind === 'files' && files.length === 0) return null;
    if (kind === 'text' && !text.trim()) return null;
    if (this.activeOutboundCount() >= config.maxConcurrentTransfers) {
      this.options.events.onNotice('warning', 'Too many transfers are already running. Wait for one to finish.');
      return null;
    }

    const items: TransferItem[] = files.map((file) => ({
      id: file.id,
      name: sanitizeFilename(file.name),
      size: file.size,
      mime: safeMime(file.mime),
      ...(file.relPath ? { relPath: file.relPath } : {}),
    }));

    const totalSize = kind === 'files' ? items.reduce((sum, item) => sum + item.size, 0) : text.length;
    const transferId = secureId('t');

    const record: TransferRecord = {
      id: transferId,
      direction: 'sending',
      peerId,
      peerName: this.options.getPeerName(peerId),
      kind,
      items,
      totalSize,
      totalBytes: 0,
      currentFileIndex: 0,
      fileBytes: 0,
      status: 'requesting',
      startedAt: Date.now(),
      bytesPerSecond: 0,
      etaSeconds: null,
      received: [],
      ...(kind === 'text' ? { text } : {}),
    };

    const state: OutboundState = {
      record,
      files,
      cancelled: false,
      pausedUntil: 0,
      meter: new SpeedMeter(),
      lastEmit: 0,
      sentBytes: 0,
      framesSent: 0,
      timer: setTimeout(() => {
        const current = this.outbound.get(transferId);
        if (!current || current.record.status !== 'requesting') return;
        this.failOutbound(transferId, 'No response from the other device.');
      }, config.incomingRequestTtlMs),
    };
    if (state.timer) state.timer.unref?.();
    this.outbound.set(transferId, state);
    this.emit(state.record, true);

    this.options.peers.sendControl(peerId, {
      t: 'TRANSFER_REQUEST',
      transferId,
      kind,
      items,
      totalSize,
      ...(kind === 'text' ? { text } : {}),
      createdAt: Date.now(),
    });

    return transferId;
  }

  private emit(record: TransferRecord, force = false): void {
    const now = performance.now();
    const state = this.outbound.get(record.id) ?? this.inbound.get(record.id);
    if (state) {
      if (!force && now - state.lastEmit < PROGRESS_EMIT_MS && record.status === 'active') return;
      state.lastEmit = now;
    }
    // Always hand React a fresh object so memoised rows re-render correctly.
    this.options.events.onUpdate({ ...record, received: [...record.received] });
  }

  private failOutbound(transferId: string, message: string): void {
    const state = this.outbound.get(transferId);
    if (!state) return;
    if (state.timer) clearTimeout(state.timer);
    state.cancelled = true;
    state.record.status = 'failed';
    state.record.error = message;
    state.record.endedAt = Date.now();
    this.scheduleCleanup(transferId, 'outbound');
    this.emit(state.record, true);
    this.options.events.onNotice('error', message);
    this.recordHistory(state.record, 'failed');
  }

  /** Sequential, backpressure-aware file streaming. */
  private async runOutbound(transferId: string): Promise<void> {
    const state = this.outbound.get(transferId);
    if (!state) return;
    const { record } = state;
    record.status = 'active';
    record.startedAt = Date.now();
    state.meter.reset();
    this.emit(record, true);

    try {
      for (let index = 0; index < state.files.length; index += 1) {
        if (state.cancelled || this.disposed) return;
        const file = state.files[index] as QueuedFile;
        record.currentFileIndex = index;
        record.fileBytes = 0;
        record.fileSize = file.size;

        // In-band on purpose: the `ctl` and `bin` channels are separate SCTP streams,
        // so markers sent on `ctl` could overtake the bytes they describe.
        const started = this.options.peers.sendInBand(record.peerId, {
          t: 'FILE_START',
          transferId,
          fileIndex: index,
          size: file.size,
        });
        if (!started) throw new Error('The connection to the other device was lost.');

        let offset = 0;
        while (offset < file.size) {
          if (state.cancelled || this.disposed) return;

          // Receiver-side flow control (used when it writes to disk).
          while (Date.now() < state.pausedUntil && !state.cancelled) {
            await new Promise((resolve) => setTimeout(resolve, 60));
          }

          // Backpressure: never let the data channel buffer run away.
          if (this.options.peers.bufferedAmount(record.peerId) > config.maxBufferedAmount) {
            const drained = await this.options.peers.waitForDrain(record.peerId);
            if (!drained) throw new Error('The connection stalled while sending.');
          }

          const end = Math.min(offset + config.chunkSize, file.size);
          const slice = file.file.slice(offset, end);
          const buffer = await slice.arrayBuffer();
          const payload = new Uint8Array(buffer);

          const sent = this.options.peers.sendBinary(
            record.peerId,
            encodeFrame({ transferId, fileIndex: index, offset, length: payload.byteLength }, payload),
          );
          if (!sent) throw new Error('The data channel closed during the transfer.');
          state.framesSent += 1;
          if (state.framesSent % 32 === 0) {
            log.debug(
              `transfer: ${state.framesSent} frames sent, offset ${offset}/${file.size}, buffered ${this.options.peers.bufferedAmount(record.peerId)}`,
            );
          }

          offset = end;
          state.sentBytes += payload.byteLength;
          record.fileBytes = offset;
          record.totalBytes = state.sentBytes;
          const speed = state.meter.update(state.sentBytes);
          record.bytesPerSecond = speed;
          const remaining = record.totalSize - state.sentBytes;
          record.etaSeconds = state.meter.eta(remaining);
          this.emit(record);
        }

        const digest = await sha256Hex(file.file);
        if (
          !this.options.peers.sendInBand(record.peerId, {
            t: 'FILE_END',
            transferId,
            fileIndex: index,
            bytes: offset,
            ...(digest ? { sha256: digest } : {}),
          })
        ) {
          throw new Error('The connection to the other device was lost.');
        }
        record.currentFileIndex = index + 1;
        record.fileBytes = 0;
        this.emit(record, true);
      }

      record.status = 'completed';
      record.totalBytes = state.sentBytes;
      record.bytesPerSecond = state.meter.bytesPerSecond;
      record.etaSeconds = 0;
      record.endedAt = Date.now();
      this.options.peers.sendInBand(record.peerId, { t: 'TRANSFER_DONE', transferId, bytes: state.sentBytes });
      this.options.peers.sendControl(record.peerId, {
        t: 'TRANSFER_COMPLETE',
        transferId,
        bytes: state.sentBytes,
      });
      this.emit(record, true);
      if (record.kind === 'files') {
        this.options.events.onNotice('success', `Sent ${record.items.length === 1 ? record.items[0]?.name : `${record.items.length} files`} to ${record.peerName}.`);
      }
      this.recordHistory(record, 'completed');
      this.scheduleCleanup(transferId, 'outbound');
    } catch (error) {
      const message = (error as Error).message || 'The transfer failed.';
      if (!state.cancelled) this.failOutbound(transferId, message);
      this.options.peers.sendControl(record.peerId, {
        t: 'TRANSFER_ERROR',
        transferId,
        code: 'sender-failed',
        message: message.slice(0, 200),
      });
    }
  }

  private scheduleCleanup(transferId: string, side: 'outbound' | 'inbound'): void {
    const timer = setTimeout(() => {
      if (side === 'outbound') {
        const state = this.outbound.get(transferId);
        if (state?.timer) clearTimeout(state.timer);
        this.outbound.delete(transferId);
      }
    }, 60_000);
    timer.unref?.();
  }

  /* ------------------------------------------------------------------ *
   * Inbound
   * ------------------------------------------------------------------ */

  private ensureRequestValidation(message: Extract<PeerMessage, { t: 'TRANSFER_REQUEST' }>): IncomingRequest | null {
    if (message.kind === 'files' && message.items.length === 0) return null;
    if (message.kind === 'text' && !message.text) return null;
    const items = message.items.slice(0, config.maxFileCount).map((item) => ({
      id: item.id,
      name: sanitizeFilename(item.name),
      size: Math.max(0, item.size),
      mime: safeMime(item.mime),
      ...(item.relPath ? { relPath: item.relPath } : {}),
    }));
    const totalSize =
      message.kind === 'files' ? items.reduce((sum, item) => sum + item.size, 0) : (message.text ?? '').length;
    if (totalSize > config.maxTotalBytes) return null;
    return {
      id: message.transferId,
      peerId: '',
      peerName: '',
      kind: message.kind,
      items,
      totalSize,
      ...(message.text ? { text: message.text } : {}),
      createdAt: Date.now(),
      expiresAt: Date.now() + config.incomingRequestTtlMs,
    };
  }

  private handleTransferRequest(peerId: string, message: Extract<PeerMessage, { t: 'TRANSFER_REQUEST' }>): void {
    const request = this.ensureRequestValidation(message);
    if (!request) {
      log.warn('transfer: rejected malformed request');
      this.options.peers.sendControl(peerId, {
        t: 'TRANSFER_REJECT',
        transferId: message.transferId,
        reason: 'unsupported',
      });
      return;
    }
    if (this.inbound.has(message.transferId) || this.pendingRequests.has(message.transferId)) return;

    request.peerId = peerId;
    request.peerName = this.options.getPeerName(peerId);
    this.pendingRequests.set(request.id, request);

    const timer = setTimeout(() => {
      if (!this.pendingRequests.has(request.id)) return;
      this.pendingRequests.delete(request.id);
      this.requestTimers.delete(request.id);
      this.options.events.onIncomingResolved(request.id, 'expired');
      this.options.peers.sendControl(peerId, {
        t: 'TRANSFER_REJECT',
        transferId: request.id,
        reason: 'declined',
      });
    }, config.incomingRequestTtlMs);
    timer.unref?.();
    this.requestTimers.set(request.id, timer);

    this.options.events.onIncomingRequest(request);
  }

  getPendingRequest(transferId: string): IncomingRequest | undefined {
    return this.pendingRequests.get(transferId);
  }

  /** Receiver accepted: set up assembly and tell the sender to start streaming. */
  async acceptIncoming(transferId: string): Promise<boolean> {
    const request = this.pendingRequests.get(transferId);
    if (!request) return false;
    const timer = this.requestTimers.get(transferId);
    if (timer) clearTimeout(timer);
    this.requestTimers.delete(transferId);
    this.pendingRequests.delete(transferId);

    const directory = this.options.getReceiveDirectory?.() ?? null;
    const taken = new Set<string>();
    const files: InboundFileState[] = request.items.map((item, index) => ({
      index,
      item,
      chunks: directory ? null : [],
      writer: null,
      savedName: buildSaveName(item.relPath ? item.relPath.split('/').pop() ?? item.name : item.name, taken),
      received: 0,
      streamed: false,
    }));

    const record: TransferRecord = {
      id: transferId,
      direction: 'receiving',
      peerId: request.peerId,
      peerName: request.peerName,
      kind: request.kind,
      items: request.items,
      totalSize: request.totalSize,
      totalBytes: 0,
      currentFileIndex: 0,
      fileBytes: 0,
      status: 'active',
      startedAt: Date.now(),
      bytesPerSecond: 0,
      etaSeconds: null,
      text: request.text,
      received: [],
      directWrite: Boolean(directory),
    };

    const state: InboundState = {
      framesReceived: 0,
      endsSeen: 0,
      senderDone: false,
      record,
      files,
      current: null,
      paused: false,
      meter: new SpeedMeter(),
      lastEmit: 0,
      writeQueueDepth: 0,
      writeQueueBytes: 0,
      bytesSinceFlowCheck: 0,
      flowPausedSent: false,
      cancelled: false,
    };
    this.inbound.set(transferId, state);
    this.emit(record, true);

    const started = this.options.peers.sendControl(request.peerId, {
      t: 'TRANSFER_ACCEPT',
      transferId,
      direct: Boolean(directory),
    });
    if (!started) {
      this.finishInbound(transferId, 'failed', 'The connection to the other device was lost.');
      return false;
    }

    // Text shares are complete the moment they are accepted.
    if (request.kind === 'text') {
      this.completeText(transferId);
    }
    return true;
  }

  rejectIncoming(transferId: string, reason: 'declined' | 'busy' | 'too-large' | 'unsupported' = 'declined'): void {
    const request = this.pendingRequests.get(transferId);
    if (!request) return;
    const timer = this.requestTimers.get(transferId);
    if (timer) clearTimeout(timer);
    this.requestTimers.delete(transferId);
    this.pendingRequests.delete(transferId);
    this.options.peers.sendControl(request.peerId, { t: 'TRANSFER_REJECT', transferId, reason });
    this.options.events.onIncomingResolved(transferId, 'rejected');
  }

  private async openWriter(state: InboundState, file: InboundFileState): Promise<boolean> {
    const directory = this.options.getReceiveDirectory?.() ?? null;
    if (!directory || !file.chunks) {
      if (!directory) return false;
    }
    try {
      if (!directory) return false;
      const handle = await directory.getFileHandle(file.savedName, { create: true });
      file.writer = await handle.createWritable();
      file.streamed = true;
      return true;
    } catch (error) {
      log.warn('transfer: direct write unavailable', { error: (error as Error).message });
      file.chunks = file.chunks ?? [];
      file.writer = null;
      state.record.directWrite = false;
      return false;
    }
  }

  private handleFileStart(peerId: string, message: Extract<FrameControl, { t: 'FILE_START' }>): void {
    const state = this.inbound.get(message.transferId);
    if (!state || state.cancelled) return;
    if (state.record.peerId !== peerId) {
      log.warn('transfer: FILE_START from unexpected peer');
      return;
    }
    const file = state.files[message.fileIndex];
    if (!file) return;
    state.current = file;
    file.received = 0;
    state.record.currentFileIndex = message.fileIndex;
    state.record.fileBytes = 0;
    this.emit(state.record, true);
    if (state.record.directWrite) {
      void this.openWriter(state, file);
    }
  }

  private handleFramePayload(state: InboundState, fileIndex: number, offset: number, payload: Uint8Array): void {
    const file = state.files[fileIndex];
    if (!file) return;
    const expected = file.item.size;
    if (offset + payload.byteLength > expected) {
      // A peer must never write past the announced size.
      log.warn('transfer: frame exceeds announced file size');
      this.finishInbound(state.record.id, 'failed', 'The incoming data did not match the announced file size.');
      return;
    }

    if (file.writer) {
      state.writeQueueDepth += 1;
      state.writeQueueBytes += payload.byteLength;
      const copy = new Uint8Array(payload); // detach from the decoder buffer
      file.writer
        .write(copy)
        .catch((error: Error) => {
          log.warn('transfer: write failed', { error: error.message });
        })
        .finally(() => {
          state.writeQueueDepth -= 1;
          state.writeQueueBytes -= copy.byteLength;
        });
      this.evaluateFlowControl(state);
    } else if (file.chunks) {
      const copy = new Uint8Array(payload);
      file.chunks.push(new Blob([copy], { type: file.item.mime }));
    } else {
      return;
    }

    file.received += payload.byteLength;
    state.framesReceived += 1;
    if (state.framesReceived % 32 === 0) {
      log.debug(
        `transfer: ${state.framesReceived} frames received, offset ${offset} + ${payload.byteLength} = ${offset + payload.byteLength}/${expected}`,
      );
    }
    state.record.fileBytes = file.received;
    state.record.totalBytes += payload.byteLength;
    const speed = state.meter.update(state.record.totalBytes);
    state.record.bytesPerSecond = speed;
    state.record.etaSeconds = state.meter.eta(Math.max(0, state.record.totalSize - state.record.totalBytes));
    this.emit(state.record);
  }

  /** Ask the sender to slow down when local writes (disk) fall behind. */
  private evaluateFlowControl(state: InboundState): void {
    const overloaded = state.writeQueueDepth > 12 || state.writeQueueBytes > 8 * 1024 * 1024;
    if (overloaded && !state.flowPausedSent) {
      state.flowPausedSent = true;
      state.paused = true;
      this.options.peers.sendControl(state.record.peerId, { t: 'FLOW', transferId: state.record.id, paused: true });
      return;
    }
    if (!overloaded && state.flowPausedSent && state.writeQueueDepth <= 3) {
      state.flowPausedSent = false;
      state.paused = false;
      this.options.peers.sendControl(state.record.peerId, { t: 'FLOW', transferId: state.record.id, paused: false });
    }
  }

  private async handleFileEnd(
    peerId: string,
    message: Extract<FrameControl, { t: 'FILE_END' }>,
  ): Promise<void> {
    const state = this.inbound.get(message.transferId);
    if (!state || state.cancelled) return;
    if (state.record.peerId !== peerId) return;
    const file = state.files[message.fileIndex];
    if (!file) return;
    state.endsSeen += 1;

    if (message.bytes !== file.received) {
      this.finishInbound(state.record.id, 'failed', 'The file did not arrive completely.');
      return;
    }

    if (file.writer) {
      try {
        await file.writer.close();
      } catch (error) {
        log.warn('transfer: closing file failed', { error: (error as Error).message });
      }
      file.writer = null;
      state.record.received.push({
        id: `${message.transferId}-${file.index}`,
        name: file.savedName,
        mime: file.item.mime,
        size: file.received,
        blob: null,
        url: null,
        streamedToDisk: true,
        receivedBytes: file.received,
      });
    } else {
      const chunks = file.chunks ?? [];
      const blob = new Blob(chunks, { type: file.item.mime });
      file.chunks = [];

      if (message.sha256) {
        const actual = await sha256Hex(blob);
        if (actual && actual !== message.sha256) {
          this.finishInbound(
            state.record.id,
            'failed',
            `${file.savedName} did not arrive intact. Ask the sender to try again.`,
          );
          return;
        }
      }

      state.record.received.push({
        id: `${message.transferId}-${file.index}`,
        name: file.savedName,
        mime: file.item.mime,
        size: blob.size,
        blob,
        url: URL.createObjectURL(blob),
        streamedToDisk: false,
        receivedBytes: blob.size,
      });
    }

    state.current = null;
    this.emit(state.record, true);
    // Assembly above is asynchronous, so the transfer can only be declared finished
    // once the last file is really on the other side of this await.
    this.maybeCompleteInbound(state);
  }

  /**
   * Finish a receiving transfer once the sender is done, every marker has been seen
   * and every file has been assembled. Both conditions are required: markers arrive
   * before the (async) assembly of the file they close.
   */
  private maybeCompleteInbound(state: InboundState): void {
    if (!state.senderDone || state.cancelled) return;
    if (state.record.kind !== 'files' || state.record.status !== 'active') return;
    if (state.endsSeen < state.record.items.length) return;
    if (state.record.received.length < state.record.items.length) return;
    this.finishInbound(state.record.id, 'completed');
  }

  private completeText(transferId: string): void {
    const state = this.inbound.get(transferId);
    if (!state) return;
    state.record.status = 'completed';
    state.record.totalBytes = state.record.text?.length ?? 0;
    state.record.endedAt = Date.now();
    this.emit(state.record, true);
    this.options.peers.sendControl(state.record.peerId, {
      t: 'TRANSFER_COMPLETE',
      transferId,
      bytes: state.record.totalBytes,
    });
    this.recordHistory(state.record, 'completed');
  }

  private finishInbound(transferId: string, status: 'completed' | 'failed' | 'cancelled' | 'rejected', message?: string): void {
    const state = this.inbound.get(transferId);
    if (!state) return;
    state.cancelled = status !== 'completed';
    state.record.status = status;
    state.record.endedAt = Date.now();
    if (message) state.record.error = message;
    for (const file of state.files) {
      try {
        void file.writer?.close();
      } catch {
        /* ignore */
      }
      file.writer = null;
      if (status !== 'completed') file.chunks = [];
    }
    if (status === 'completed') state.record.bytesPerSecond = state.meter.bytesPerSecond;
    this.emit(state.record, true);

    if (status === 'completed') {
      const total = state.record.totalBytes;
      const label = state.record.kind === 'text'
        ? `Text received from ${state.record.peerName}.`
        : `${state.record.items.length === 1 ? state.record.items[0]?.name : `${state.record.items.length} files`} received from ${state.record.peerName}.`;
      this.options.events.onNotice('success', `${label} (${total.toLocaleString()} bytes)`);
      this.recordHistory(state.record, 'completed');
      const directory = this.options.getReceiveDirectory?.() ?? null;
      if (directory && state.record.directWrite) {
        this.options.events.onSavedToDisk(state.record, directory.name);
      }
    } else if (status === 'failed' && message) {
      this.options.events.onNotice('error', message);
      this.recordHistory(state.record, 'failed');
    }

    this.options.peers.sendControl(state.record.peerId, {
      t: 'FLOW',
      transferId,
      paused: false,
    });

    const timer = setTimeout(() => this.inbound.delete(transferId), 60_000);
    timer.unref?.();
  }

  private recordHistory(record: TransferRecord, status: HistoryEntry['status']): void {
    if (record.kind === 'text' && status === 'completed') {
      // Text is not persisted to history to avoid keeping message content.
      return;
    }
    const entry: HistoryEntry = {
      id: record.id,
      direction: record.direction,
      peerName: record.peerName,
      kind: record.kind,
      fileNames: record.items.slice(0, 8).map((item) => item.name),
      fileCount: record.items.length,
      totalSize: record.totalBytes || record.totalSize,
      completedAt: Date.now(),
      status,
    };
    this.options.events.onHistory(entry, status === 'completed');
  }

  /* ------------------------------------------------------------------ *
   * Message routing
   * ------------------------------------------------------------------ */

  handleMessage(peerId: string, message: PeerMessage): void {
    switch (message.t) {
      case 'TRANSFER_REQUEST':
        this.handleTransferRequest(peerId, message);
        return;
      case 'TRANSFER_ACCEPT': {
        const state = this.outbound.get(message.transferId);
        if (!state || state.record.status !== 'requesting') return;
        if (state.timer) clearTimeout(state.timer);
        if (state.record.kind === 'text') {
          state.record.status = 'completed';
          state.record.totalBytes = state.record.totalSize;
          state.record.endedAt = Date.now();
          this.emit(state.record, true);
          this.options.events.onNotice('success', `Text sent to ${state.record.peerName}.`);
          this.options.peers.sendControl(state.record.peerId, {
            t: 'TRANSFER_COMPLETE',
            transferId: state.record.id,
            bytes: state.record.totalSize,
          });
          return;
        }
        void this.runOutbound(message.transferId);
        return;
      }
      case 'TRANSFER_REJECT': {
        const state = this.outbound.get(message.transferId);
        if (!state) return;
        if (state.timer) clearTimeout(state.timer);
        state.cancelled = true;
        state.record.status = 'rejected';
        state.record.endedAt = Date.now();
        state.record.error =
          message.reason === 'busy'
            ? `${state.record.peerName} is busy with another transfer.`
            : message.reason === 'too-large'
              ? `${state.record.peerName} could not accept a transfer of this size.`
              : message.reason === 'unsupported'
                ? `${state.record.peerName} could not accept this kind of transfer.`
                : `${state.record.peerName} declined the transfer.`;
        this.emit(state.record, true);
        this.options.events.onNotice('warning', state.record.error);
        this.recordHistory(state.record, 'rejected');
        return;
      }
      case 'TRANSFER_CANCEL': {
        if (message.by === 'receiver') {
          const state = this.outbound.get(message.transferId);
          if (!state) return;
          if (state.timer) clearTimeout(state.timer);
          state.cancelled = true;
          state.record.status = 'cancelled';
          state.record.endedAt = Date.now();
          state.record.error = `${state.record.peerName} cancelled the transfer.`;
          this.emit(state.record, true);
          this.options.events.onNotice('warning', state.record.error);
          this.recordHistory(state.record, 'cancelled');
          return;
        }
        const inbound = this.inbound.get(message.transferId);
        if (!inbound) return;
        this.finishInbound(message.transferId, 'cancelled', 'The sender cancelled the transfer.');
        return;
      }
      case 'TRANSFER_ERROR': {
        const state = this.outbound.get(message.transferId) ?? this.inbound.get(message.transferId);
        if (!state) return;
        if (state.record.status === 'completed') return;
        state.record.status = 'failed';
        state.record.error = message.message || 'The transfer failed.';
        state.record.endedAt = Date.now();
        if (state && 'cancelled' in state) state.cancelled = true;
        this.emit(state.record, true);
        this.options.events.onNotice('error', state.record.error);
        this.recordHistory(state.record, 'failed');
        return;
      }
      case 'FLOW': {
        const state = this.outbound.get(message.transferId);
        if (!state) return;
        state.pausedUntil = message.paused ? Number.MAX_SAFE_INTEGER : 0;
        return;
      }
      case 'TRANSFER_COMPLETE': {
        // Redundant belt-and-braces trigger: the authoritative signal travels in-band.
        const inbound = this.inbound.get(message.transferId);
        if (inbound) {
          inbound.senderDone = true;
          this.maybeCompleteInbound(inbound);
        }
        return;
      }
      default:
        return;
    }
  }

  handleBinary(peerId: string, frame: ArrayBuffer): void {
    let decoder = this.decoders.get(peerId);
    if (!decoder) {
      decoder = new FrameDecoder(config.chunkSize * 4);
      this.decoders.set(peerId, decoder);
    }

    let frames;
    try {
      frames = decoder.push(frame);
    } catch (error) {
      // A desynchronised stream cannot be recovered: reset and fail the transfer
      // that is currently receiving from this peer.
      log.warn('transfer: dropping a corrupt data stream', { peerId, error: (error as Error).message });
      decoder.reset();
      for (const state of this.inbound.values()) {
        if (state.record.peerId === peerId && state.record.status === 'active') {
          this.finishInbound(state.record.id, 'failed', 'The incoming data was corrupted.');
        }
      }
      return;
    }

    if (frames.length === 0) return;

    for (const decoded of frames) {
      const state = this.inbound.get(decoded.header.transferId);
      if (!state || state.record.peerId !== peerId) continue;
      if (state.cancelled) continue;

      if (decoded.kind === FRAME_KIND_CONTROL) {
        const control = decoded.header;
        if (control.t === 'FILE_START') this.handleFileStart(peerId, control);
        else if (control.t === 'FILE_END') void this.handleFileEnd(peerId, control);
        else {
          state.senderDone = true;
          this.maybeCompleteInbound(state);
        }
        continue;
      }

      this.handleFramePayload(state, decoded.header.fileIndex, decoded.header.offset, decoded.payload);
    }
  }

  /**
  /** Sender-side cancellation. */
  cancel(transferId: string): void {
    const outState = this.outbound.get(transferId);
    if (outState) {
      if (outState.record.status === 'completed' || outState.record.status === 'cancelled') return;
      outState.cancelled = true;
      if (outState.timer) clearTimeout(outState.timer);
      outState.record.status = 'cancelled';
      outState.record.endedAt = Date.now();
      this.emit(outState.record, true);
      this.options.peers.sendControl(outState.record.peerId, {
        t: 'TRANSFER_CANCEL',
        transferId,
        by: 'sender',
      });
      this.options.events.onNotice('info', 'Transfer cancelled.');
      this.recordHistory(outState.record, 'cancelled');
      return;
    }
    const inState = this.inbound.get(transferId);
    if (inState) {
      inState.cancelled = true;
      this.options.peers.sendControl(inState.record.peerId, { t: 'TRANSFER_CANCEL', transferId, by: 'receiver' });
      this.finishInbound(transferId, 'cancelled', 'You cancelled the incoming transfer.');
      return;
    }
    const pending = this.pendingRequests.get(transferId);
    if (pending) this.rejectIncoming(transferId, 'declined');
  }

  /** Drop everything belonging to a peer that disappeared. */
  handlePeerGone(peerId: string): void {
    this.decoders.delete(peerId);
    for (const state of this.outbound.values()) {
      if (state.record.peerId !== peerId) continue;
      if (state.record.status === 'completed' || state.record.status === 'cancelled') continue;
      if (state.timer) clearTimeout(state.timer);
      state.cancelled = true;
      state.record.status = 'failed';
      state.record.error = `${state.record.peerName} disconnected before the transfer finished.`;
      state.record.endedAt = Date.now();
      this.emit(state.record, true);
      this.recordHistory(state.record, 'failed');
    }
    for (const [id, state] of this.inbound) {
      if (state.record.peerId !== peerId) continue;
      if (state.record.status === 'completed') continue;
      this.finishInbound(id, 'failed', 'The sending device disconnected.');
    }
    for (const [id, request] of this.pendingRequests) {
      if (request.peerId !== peerId) continue;
      const timer = this.requestTimers.get(id);
      if (timer) clearTimeout(timer);
      this.requestTimers.delete(id);
      this.pendingRequests.delete(id);
      this.options.events.onIncomingResolved(id, 'expired');
    }
  }

  /**
   * Transfers that are still running. Finished records linger for a short while
   * (history + cleanup) and must not count towards the concurrency limit.
   */
  activeOutboundCount(): number {
    let count = 0;
    for (const state of this.outbound.values()) {
      if (state.record.status === 'requesting' || state.record.status === 'active') count += 1;
    }
    return count;
  }

  dispose(): void {
    this.disposed = true;
    for (const state of this.outbound.values()) {
      if (state.timer) clearTimeout(state.timer);
      state.cancelled = true;
    }
    for (const state of this.inbound.values()) {
      state.cancelled = true;
      for (const file of state.files) {
        try {
          void file.writer?.close();
        } catch {
          /* ignore */
        }
        file.chunks = [];
      }
    }
    for (const timer of this.requestTimers.values()) clearTimeout(timer);
    this.requestTimers.clear();
    this.pendingRequests.clear();
    this.outbound.clear();
    this.inbound.clear();
  }
}

export type { LinkIdentity };
