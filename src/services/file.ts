/**
 * Local file helpers — previews, metadata, downloads and client-side ZIP creation.
 * Nothing here ever uploads anything: every operation uses browser APIs only.
 */
import { Zip, ZipPassThrough } from 'fflate';
import { config } from '../config';
import type { QueuedFile, ReceivedFile } from '../types/transfer';
import { fileExtension, fileCategory, isPreviewableImage, isPreviewableVideo, isBrowserReadableText } from '../utils/fileKind';
import { safeMime, sanitizeFilename, uniqueFilename } from '../utils/validation';
import { secureId } from '../utils/id';
import { log } from './logger';

const MAX_VIDEO_POSTERS = 8;
let videoPostersCreated = 0;

export function resetPosterBudget(): void {
  videoPostersCreated = 0;
}

/** Build a queue item, generating a local preview where the browser supports it. */
export async function createQueuedFile(file: File): Promise<QueuedFile> {
  const name = sanitizeFilename(file.name, 'file');
  const mime = safeMime(file.type);
  const item: QueuedFile = {
    id: secureId('q'),
    file,
    name,
    size: file.size,
    mime,
    previewUrl: null,
    durationSeconds: null,
  };

  if (isPreviewableImage(mime, name)) {
    item.previewUrl = URL.createObjectURL(file);
    return item;
  }

  if (isPreviewableVideo(mime, name)) {
    if (videoPostersCreated < MAX_VIDEO_POSTERS) {
      videoPostersCreated += 1;
      const poster = await extractVideoPoster(file).catch(() => null);
      if (poster) item.previewUrl = poster;
    }
    const duration = await readMediaDuration(file, 'video').catch(() => null);
    item.durationSeconds = duration;
    return item;
  }

  if (fileCategory(mime, name) === 'audio') {
    const duration = await readMediaDuration(file, 'audio').catch(() => null);
    item.durationSeconds = duration;
  }

  return item;
}

/** Grab a poster frame from a video file without uploading it anywhere. */
export function extractVideoPoster(file: File, timeoutMs = 6000): Promise<string | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    let settled = false;

    const finish = (result: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.onloadeddata = null;
      video.onseeked = null;
      video.onerror = null;
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* ignore */
      }
      URL.revokeObjectURL(url);
      resolve(result);
    };

    const capture = () => {
      try {
        const canvas = document.createElement('canvas');
        const width = video.videoWidth || 320;
        const height = video.videoHeight || 180;
        const scale = Math.min(1, 480 / Math.max(width, height));
        canvas.width = Math.max(1, Math.round(width * scale));
        canvas.height = Math.max(1, Math.round(height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          finish(null);
          return;
        }
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        finish(canvas.toDataURL('image/jpeg', 0.72));
      } catch {
        finish(null);
      }
    };

    const timer = setTimeout(() => finish(null), timeoutMs);

    try {
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.onloadeddata = () => {
        if (Number.isFinite(video.duration) && video.duration > 0) {
          try {
            video.currentTime = Math.min(1, video.duration / 3);
            return;
          } catch {
            /* fall through to direct capture */
          }
        }
        capture();
      };
      video.onseeked = capture;
      video.onerror = () => finish(null);
      video.src = url;
    } catch (error) {
      log.debug('video poster error', (error as Error).message);
      finish(null);
    }
  });
}

export function readMediaDuration(file: File, kind: 'audio' | 'video'): Promise<number | null> {
  return new Promise((resolve) => {
    const element = document.createElement(kind);
    const url = URL.createObjectURL(file);
    const timer = setTimeout(() => done(null), 5000);
    function done(value: number | null) {
      clearTimeout(timer);
      element.removeAttribute('src');
      URL.revokeObjectURL(url);
      resolve(value);
    }
    element.preload = 'metadata';
    element.onloadedmetadata = () => {
      const duration = (element as HTMLMediaElement).duration;
      done(Number.isFinite(duration) && duration > 0 ? duration : null);
    };
    element.onerror = () => done(null);
    element.src = url;
  });
}

export function revokeQueuedFile(item: QueuedFile): void {
  if (item.previewUrl && item.previewUrl.startsWith('blob:')) {
    URL.revokeObjectURL(item.previewUrl);
  }
  item.previewUrl = null;
}

export function revokeReceivedFile(file: ReceivedFile): void {
  if (file.url && file.url.startsWith('blob:')) URL.revokeObjectURL(file.url);
  file.url = null;
}

/** Sanitised, unique download name — never trust the peer's filename. */
export function buildSaveName(name: string, taken: Set<string>): string {
  return uniqueFilename(sanitizeFilename(name), taken);
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = sanitizeFilename(filename);
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 1500);
}

export function openObjectUrl(url: string): void {
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Read the first N bytes of a text-like file for an inline preview. */
export async function readTextPreview(blob: Blob, maxBytes = 256 * 1024): Promise<string> {
  const slice = blob.slice(0, maxBytes);
  const text = await slice.text();
  return blob.size > maxBytes ? `${text}\n\n… (${blob.size - maxBytes} bytes not shown)` : text;
}

export function canPreviewInline(mime: string, name: string): boolean {
  return isBrowserReadableText(mime, name) && fileExtension(name) !== 'svg';
}

export interface SaveDirectoryResult {
  handle: FileSystemDirectoryHandle | null;
  name: string | null;
}

/** Ask the user for a destination folder (Chromium only). */
export async function pickSaveDirectory(): Promise<SaveDirectoryResult> {
  const picker = (window as unknown as { showDirectoryPicker?: (opts?: unknown) => Promise<FileSystemDirectoryHandle> })
    .showDirectoryPicker;
  if (typeof picker !== 'function') return { handle: null, name: null };
  try {
    const handle = await picker.call(window, { mode: 'readwrite', id: 'lanshare-receive' });
    return { handle, name: handle.name };
  } catch {
    return { handle: null, name: null };
  }
}

export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (navigator.storage?.persist) {
      return await navigator.storage.persist();
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Create a ZIP archive entirely in the browser and stream file data into it.
 * Multiple received files can then be saved as one download without a server round-trip.
 */
export async function zipBlobs(
  entries: Array<{ name: string; blob: Blob }>,
  onProgress?: (ratio: number) => void,
): Promise<Blob> {
  if (entries.length === 0) throw new Error('Nothing to archive');
  const totalBytes = entries.reduce((sum, entry) => sum + entry.blob.size, 0) || 1;
  let processed = 0;

  const parts: BlobPart[] = [];
  let finished = false;
  let failure: Error | null = null;
  let resolveDone: () => void = () => undefined;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      if (!finished) {
        finished = true;
        resolveDone();
      }
      return;
    }
    const copy = new Uint8Array(chunk.byteLength);
    copy.set(chunk);
    parts.push(copy);
    if (final && !finished) {
      finished = true;
      resolveDone();
    }
  });

  for (const entry of entries) {
    const stream = new ZipPassThrough(sanitizeFilename(entry.name));
    zip.add(stream);
    const reader = entry.blob.stream().getReader();
    for (;;) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;
      stream.push(value, false);
      processed += value.byteLength;
      onProgress?.(Math.min(0.99, processed / totalBytes));
    }
    stream.push(new Uint8Array(0), true);
    if (entry.blob.size === 0) processed += 1;
  }
  zip.end();
  await done;
  if (failure) throw failure;

  onProgress?.(1);
  return new Blob(parts, { type: 'application/zip' });
}

/** Human label for the archive filename: "LANShare transfer 2026-09-25.zip" */
export function archiveName(): string {
  const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return `LANShare transfer ${stamp}.zip`;
}

export function emptyQueueItemBudget(): number {
  return config.maxFileCount;
}
