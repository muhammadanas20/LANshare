import type { TransferItem } from './protocol';

export type TransferDirection = 'sending' | 'receiving';

export type TransferStatus =
  | 'requesting' // sender: waiting for the receiver to accept
  | 'active'
  | 'completed'
  | 'cancelled'
  | 'rejected'
  | 'failed';

export interface ReceivedFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  blob: Blob | null;
  /** Object URL for preview/download; revoked during cleanup. */
  url: string | null;
  /** True when the bytes were streamed straight to disk instead of memory. */
  streamedToDisk: boolean;
  receivedBytes: number;
}

export interface TransferRecord {
  id: string;
  direction: TransferDirection;
  peerId: string;
  peerName: string;
  kind: 'files' | 'text';
  items: TransferItem[];
  totalSize: number;
  totalBytes: number;
  currentFileIndex: number;
  fileBytes: number;
  /** Size of the file currently being streamed (outbound only). */
  fileSize?: number;
  status: TransferStatus;
  startedAt: number;
  endedAt?: number;
  bytesPerSecond: number;
  etaSeconds: number | null;
  error?: string;
  /** Text payload (text shares and received text). */
  text?: string;
  received: ReceivedFile[];
  /** Receiver streams to disk through the File System Access API when true. */
  directWrite?: boolean;
}

export interface IncomingRequest {
  id: string;
  peerId: string;
  peerName: string;
  kind: 'files' | 'text';
  items: TransferItem[];
  totalSize: number;
  text?: string;
  createdAt: number;
  expiresAt: number;
}

export interface HistoryEntry {
  id: string;
  direction: TransferDirection;
  peerName: string;
  kind: 'files' | 'text';
  fileNames: string[];
  fileCount: number;
  totalSize: number;
  completedAt: number;
  status: 'completed' | 'cancelled' | 'failed' | 'rejected';
}

export interface QueuedFile {
  id: string;
  file: File;
  name: string;
  size: number;
  mime: string;
  relPath?: string;
  /** Local-only preview URLs (revoked when the item leaves the queue). */
  previewUrl?: string | null;
  /** Audio/video duration in seconds when metadata could be read locally. */
  durationSeconds?: number | null;
}
