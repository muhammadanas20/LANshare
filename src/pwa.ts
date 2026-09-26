/**
 * PWA registration.
 *
 * The service worker is a cache-first "offline shell": it caches the built app so the
 * interface loads without a network, and deliberately never caches signaling traffic.
 * Peer discovery still requires the signaling server (documented in README).
 */
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (import.meta.env.DEV) return; // keep dev reloads predictable
  if (window.location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(window.location.hostname)) {
    return;
  }

  window.addEventListener('load', () => {
    const base = import.meta.env.BASE_URL || '/';
    const scope = base.endsWith('/') ? base : `${base}/`;
    // Absolute URL: `new URL('sw.js', '/')` is invalid, so resolve against the origin.
    const swUrl = `${window.location.origin}${scope}sw.js`;
    navigator.serviceWorker
      .register(swUrl, { scope })
      .catch(() => {
        /* offline shell is optional — never surface this as an app error */
      });
  });
}

/** Ask the active service worker to refresh its cached shell (used after deploys). */
export async function refreshOfflineShell(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration();
  await registration?.update();
}
