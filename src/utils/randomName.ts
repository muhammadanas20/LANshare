import { randomIndex, randomPeerId } from './id';
import { readLocal, writeLocal } from './safeStorage';

const ADJECTIVES = [
  'Blue', 'Silent', 'Fast', 'Pixel', 'Green', 'Amber', 'Cosmic', 'Swift',
  'Lucky', 'Neon', 'Quiet', 'Solar', 'Brave', 'Clever', 'Gentle', 'Wild',
  'Bright', 'Copper', 'Velvet', 'Crimson', 'Frost', 'Golden', 'Iron', 'Nova',
];

const NOUNS = [
  'Falcon', 'Panda', 'Fox', 'Tiger', 'Rocket', 'Otter', 'Heron', 'Lynx',
  'Comet', 'Dolphin', 'Sparrow', 'Badger', 'Orca', 'Koala', 'Raven', 'Marlin',
  'Ibis', 'Wolf', 'Puma', 'Bison', 'Gecko', 'Crane', 'Finch', 'Moose',
];

function pick<T>(list: readonly T[]): T {
  return list[randomIndex(list.length)] as T;
}

/** Friendly, non-identifying device name, e.g. "Blue Falcon", "Silent Panda". */
export function randomFriendlyName(): string {
  return `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
}

export interface DeviceProfile {
  name: string;
  deviceId: string;
}

const DEVICE_NAME_KEY = 'lanshare.device.name';
const DEVICE_ID_KEY = 'lanshare.device.id';

/** Stable per-browser device id (not a fingerprint — a random local value). */
export function getDeviceId(): string {
  const existing = readLocal(DEVICE_ID_KEY);
  if (existing && /^[a-z0-9]{8,32}$/.test(existing)) return existing;
  const created = randomPeerId(12);
  writeLocal(DEVICE_ID_KEY, created);
  return created;
}

/**
 * Initial display name: a friendly random name, optionally suffixed with a
 * coarse device hint ("Blue Falcon (Phone)"). No OS/browser fingerprinting.
 */
export function defaultDisplayName(deviceLabel?: string): string {
  const base = randomFriendlyName();
  return deviceLabel ? `${base} (${deviceLabel})` : base;
}

export function loadStoredName(): string | null {
  const value = readLocal(DEVICE_NAME_KEY);
  return value && value.trim() ? value.trim() : null;
}

export function storeName(name: string): void {
  // Best-effort: a blocked storage context keeps the name for this session only.
  writeLocal(DEVICE_NAME_KEY, name.trim().slice(0, 32));
}

export { DEVICE_NAME_KEY, DEVICE_ID_KEY };

/** "Muhammad Anas" -> "MA", "Blue Falcon" -> "BF" */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return (parts[0] as string).slice(0, 2).toUpperCase();
  return `${(parts[0] as string)[0] ?? ''}${(parts[parts.length - 1] as string)[0] ?? ''}`.toUpperCase();
}
