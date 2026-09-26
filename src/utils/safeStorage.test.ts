/**
 * Storage must never be able to take the app down.
 *
 * A document in an opaque origin (an embedded iframe without `allow-same-origin`, some
 * private modes, locked-down webviews) throws a `SecurityError` when `window.localStorage`
 * is merely *read*, and a writable store can still throw `QuotaExceededError` on write.
 * These tests pin the behaviour of the accessor the whole app now goes through.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** Load a fresh copy of the module: the availability probe is memoised per instance. */
async function freshModule() {
  vi.resetModules();
  return import('./safeStorage');
}

function blockStorage(): PropertyDescriptor | undefined {
  const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new DOMException('The document is sandboxed and lacks the allow-same-origin flag.', 'SecurityError');
    },
  });
  return original;
}

afterEach(() => {
  vi.resetModules();
});

describe('safeStorage', () => {
  it('round-trips values when storage works', async () => {
    const { readLocal, writeLocal } = await freshModule();
    expect(writeLocal('round.trip', 'value-1')).toBe(true);
    expect(readLocal('round.trip')).toBe('value-1');
    expect(window.localStorage.getItem('round.trip')).toBe('value-1');
  });

  it('reports storage as available in a normal context', async () => {
    const { isLocalStorageAvailable } = await freshModule();
    expect(isLocalStorageAvailable()).toBe(true);
  });

  it('reports storage as unavailable when reading the property throws', async () => {
    const original = blockStorage();
    try {
      const { isLocalStorageAvailable } = await freshModule();
      expect(isLocalStorageAvailable()).toBe(false);
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });

  it('reads, writes and removes without throwing when storage is blocked', async () => {
    const original = blockStorage();
    try {
      const { readLocal, writeLocal, removeLocal } = await freshModule();
      expect(() => readLocal('blocked')).not.toThrow();
      expect(readLocal('blocked')).toBeNull();
      expect(writeLocal('blocked', 'kept')).toBe(false);
      // The value survives for this session through the in-memory fallback.
      expect(readLocal('blocked')).toBe('kept');
      removeLocal('blocked');
      expect(readLocal('blocked')).toBeNull();
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
      else Reflect.deleteProperty(window, 'localStorage');
    }
  });

  it('falls back to memory when only writes are rejected (quota / private mode)', async () => {
    const { readLocal, writeLocal } = await freshModule();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    });
    try {
      expect(writeLocal('quota', 'value-2')).toBe(false);
      expect(readLocal('quota')).toBe('value-2');
    } finally {
      setItem.mockRestore();
    }
  });

  it('prefers the real store over the in-memory copy', async () => {
    const { readLocal, writeLocal } = await freshModule();
    window.localStorage.setItem('pref', 'from-disk');
    writeLocal('pref', 'from-memory-then-disk');
    // The in-memory copy is written first, then persisted, so both agree.
    expect(readLocal('pref')).toBe('from-memory-then-disk');
    expect(window.localStorage.getItem('pref')).toBe('from-memory-then-disk');
  });
});
