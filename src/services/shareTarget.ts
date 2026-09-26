/**
 * Web Share Target consumer.
 *
 * When the app is installed as a PWA, the OS share sheet can hand files to us. The
 * service worker parks them in the Cache API (on-device only) and the page collects
 * them here, then clears the cache.
 */

const SHARE_CACHE = 'lanshare-incoming-share';
const SHARE_PREFIX = 'incoming-file-';

export interface SharedPayload {
  files: File[];
  text: string | null;
}

function shareCacheAvailable(): boolean {
  return typeof caches !== 'undefined';
}

export async function collectSharedFiles(): Promise<SharedPayload> {
  if (!shareCacheAvailable()) return { files: [], text: null };
  const files: File[] = [];
  let text: string | null = null;
  try {
    const cache = await caches.open(SHARE_CACHE);
    const keys = await cache.keys();
    for (const request of keys) {
      const response = await cache.match(request);
      if (!response) continue;
      const url = new URL(request.url);
      if (!url.pathname.includes(SHARE_PREFIX) && !url.pathname.startsWith(SHARE_PREFIX)) continue;

      if (url.pathname.endsWith(`${SHARE_PREFIX}text`)) {
        text = await response.text();
        continue;
      }
      const blob = await response.blob();
      const header = response.headers.get('x-lanshare-filename');
      const name = header ? decodeURIComponent(header) : 'shared-file';
      files.push(new File([blob], name, { type: blob.type || 'application/octet-stream' }));
    }
    await Promise.all(keys.map((key) => cache.delete(key)));
  } catch {
    return { files: [], text: null };
  }
  return { files, text };
}

/** Clear the parked share payload without consuming it (used when the user bails out). */
export async function clearSharedCache(): Promise<void> {
  if (!shareCacheAvailable()) return;
  try {
    await caches.delete(SHARE_CACHE);
  } catch {
    /* ignore */
  }
}

/** Listen for live share events while the app is already open. */
export function onSharedPayload(callback: () => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => undefined;
  const handler = (event: MessageEvent) => {
    if (event.data?.type === 'lanshare:shared') callback();
  };
  navigator.serviceWorker.addEventListener('message', handler);
  return () => navigator.serviceWorker.removeEventListener('message', handler);
}
