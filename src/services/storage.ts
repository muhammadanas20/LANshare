/**
 * Persistence.
 *
 *  - Preferences live in localStorage (theme, display name, toggles — nothing sensitive).
 *  - Transfer history lives in IndexedDB and stores metadata only (never file bytes).
 *  - The optional "receive folder" handle is kept in IndexedDB because File System
 *    Access handles are structured-cloneable.
 */
import { config } from '../config';
import type { HistoryEntry } from '../types/transfer';
import { readLocal, removeLocal, writeLocal } from '../utils/safeStorage';

export type ThemePreference = 'light' | 'dark' | 'system';
export type SaveBehavior = 'ask' | 'downloads' | 'folder';

export interface Settings {
  version: number;
  theme: ThemePreference;
  displayName: string;
  notifications: boolean;
  autoAccept: boolean;
  autoDownload: boolean;
  saveBehavior: SaveBehavior;
  keepHistory: boolean;
  seenOnboarding: boolean;
  receiveFolderName: string | null;
}

export const SETTINGS_KEY = 'lanshare.settings.v1';
const DB_NAME = 'lanshare';
const DB_VERSION = 1;
const STORE_HISTORY = 'history';
const STORE_META = 'meta';
const RECEIVE_DIR_KEY = 'receiveDirectory';

export const DEFAULT_SETTINGS: Settings = {
  version: 1,
  theme: 'system',
  displayName: '',
  notifications: false,
  autoAccept: false, // spec §67: must default to OFF
  autoDownload: true,
  saveBehavior: 'downloads',
  keepHistory: true,
  seenOnboarding: false,
  receiveFolderName: null,
};

export function loadSettings(): Settings {
  try {
    const raw = readLocal(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      theme: parsed.theme === 'light' || parsed.theme === 'dark' ? parsed.theme : 'system',
      saveBehavior:
        parsed.saveBehavior === 'folder' || parsed.saveBehavior === 'ask' ? parsed.saveBehavior : 'downloads',
      displayName: typeof parsed.displayName === 'string' ? parsed.displayName.slice(0, 32) : '',
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: Settings): void {
  // Best-effort: blocked/quota-limited storage keeps preferences for this session only.
  writeLocal(SETTINGS_KEY, JSON.stringify(settings));
}

export function applyTheme(preference: ThemePreference): void {
  const root = document.documentElement;
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ?? false;
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', resolved === 'dark' ? '#0b0f14' : '#f7f8fa');
}

export function watchSystemTheme(onChange: (dark: boolean) => void): () => void {
  const query = window.matchMedia?.('(prefers-color-scheme: dark)');
  if (!query) return () => undefined;
  const handler = (event: MediaQueryListEvent) => onChange(event.matches);
  query.addEventListener('change', handler);
  return () => query.removeEventListener('change', handler);
}

/* ------------------------------------------------------------------ *
 * IndexedDB helpers
 * ------------------------------------------------------------------ */

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_HISTORY)) {
        const store = db.createObjectStore(STORE_HISTORY, { keyPath: 'id' });
        store.createIndex('completedAt', 'completedAt');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

function tx<T>(
  storeName: string,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest | null,
): Promise<T | null> {
  return openDb().then(
    (db) =>
      new Promise<T | null>((resolve) => {
        if (!db) {
          resolve(null);
          return;
        }
        try {
          const transaction = db.transaction(storeName, mode);
          const store = transaction.objectStore(storeName);
          const request = run(store);
          if (!request) {
            resolve(null);
            return;
          }
          request.onsuccess = () => resolve((request.result ?? null) as T | null);
          request.onerror = () => resolve(null);
          transaction.onerror = () => resolve(null);
        } catch {
          resolve(null);
        }
      }),
  );
}

export async function addHistoryEntry(entry: HistoryEntry): Promise<void> {
  await tx(STORE_HISTORY, 'readwrite', (store) => store.put(entry));
}

export async function listHistory(limit = config.historyLimit): Promise<HistoryEntry[]> {
  const all = await tx<HistoryEntry[]>(STORE_HISTORY, 'readonly', (store) => store.getAll());
  if (!all) return [];
  return all
    .filter((entry) => entry && typeof entry.completedAt === 'number')
    .sort((a, b) => b.completedAt - a.completedAt)
    .slice(0, limit);
}

export async function clearHistory(): Promise<void> {
  await tx(STORE_HISTORY, 'readwrite', (store) => store.clear());
}

export async function saveReceiveDirectoryHandle(handle: FileSystemDirectoryHandle | null): Promise<void> {
  await tx(STORE_META, 'readwrite', (store) => (handle ? store.put(handle, RECEIVE_DIR_KEY) : store.delete(RECEIVE_DIR_KEY)));
}

export async function loadReceiveDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await tx<FileSystemDirectoryHandle>(STORE_META, 'readonly', (store) => store.get(RECEIVE_DIR_KEY));
  if (!handle) return null;
  try {
    // `queryPermission` is Chromium-only and not in the default DOM typings.
    const queryable = handle as FileSystemDirectoryHandle & {
      queryPermission?: (options: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
    };
    const permission = await queryable.queryPermission?.({ mode: 'readwrite' });
    if (permission === 'granted') return handle;
  } catch {
    return null;
  }
  return null;
}

/** Remove every trace of stored preferences/history (used by "Clear local data"). */
export async function wipeLocalData(): Promise<void> {
  removeLocal(SETTINGS_KEY);
  await clearHistory();
  await saveReceiveDirectoryHandle(null);
}
