/**
 * Storage access that never throws.
 *
 * `localStorage` is not always usable: in a document with an opaque origin (an embedded
 * iframe without `allow-same-origin`, some private/incognito modes and locked-down
 * webviews) *reading the `localStorage` property itself* throws a `SecurityError`, and
 * writes can throw `QuotaExceededError`. Every storage touch in the app goes through
 * this module, so a blocked context degrades to in-memory values for the current
 * session instead of failing the render.
 */

const memory = new Map<string, string>();
let availability: boolean | null = null;

/** The real store, or `null` when it cannot even be reached. */
function realStorage(): Storage | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage ?? null;
  } catch {
    /* SecurityError: opaque origin / storage disabled */
    return null;
  }
}

/**
 * Whether preferences (and history) can actually be persisted here.
 *
 * Probes with a real write, because a store that can be read is not necessarily
 * writable. The result is memoised — storage availability cannot change mid-session
 * in practice, and this keeps the check off the hot path.
 */
export function isLocalStorageAvailable(): boolean {
  if (availability !== null) return availability;
  const store = realStorage();
  if (!store) {
    availability = false;
    return availability;
  }
  try {
    const probe = 'lanshare.probe';
    store.setItem(probe, '1');
    store.removeItem(probe);
    availability = true;
  } catch {
    availability = false;
  }
  return availability;
}

/** Read a value: from storage when available, otherwise from this session's memory. */
export function readLocal(key: string): string | null {
  const store = realStorage();
  if (store) {
    try {
      const value = store.getItem(key);
      if (value !== null) return value;
    } catch {
      /* fall through to the in-memory copy */
    }
  }
  return memory.has(key) ? (memory.get(key) as string) : null;
}

/** Write a value. Returns whether it was persisted beyond this session. */
export function writeLocal(key: string, value: string): boolean {
  memory.set(key, value);
  const store = realStorage();
  if (!store) return false;
  try {
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Remove a value from both storage and the in-memory copy. */
export function removeLocal(key: string): void {
  memory.delete(key);
  const store = realStorage();
  if (!store) return;
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
}
