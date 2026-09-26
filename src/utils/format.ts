/** Byte-size and duration formatting. Pure functions — unit tested. */

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

/**
 * Human readable file size.
 *  1024        -> "1 KB"
 *  1_488_000   -> "1.42 MB"
 *  2_480_000_000 -> "2.31 GB"
 */
export function formatBytes(bytes: number, decimals?: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;
  const unit = UNITS[exponent] ?? 'B';
  if (exponent === 0) return `${Math.round(value)} B`;

  // 1 decimal for KB, 2 for MB and above — matches the reference formatting in the spec.
  const digits = decimals ?? (exponent === 1 ? (value >= 10 ? 0 : 1) : 2);
  const rounded = Number(value.toFixed(digits));
  return `${rounded} ${unit}`;
}

/** "18.4 MB/s" */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond, bytesPerSecond >= 10 * 1024 * 1024 ? 1 : 2)}/s`;
}

/** "2 seconds", "48 seconds", "3 min 12 sec", "1 hr 4 min" */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) {
    return '—';
  }
  if (seconds < 1) return '< 1 sec';
  const total = Math.round(seconds);
  if (total < 60) return `${total} sec`;
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  if (minutes < 60) return secs ? `${minutes} min ${secs} sec` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins ? `${hours} hr ${mins} min` : `${hours} hr`;
}

/** Countdown-style short ETA used in transfer rows: "ETA 8 sec", "ETA 2 min". */
export function formatEta(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return 'calculating…';
  if (seconds < 1) return 'almost done';
  if (seconds < 60) return `${Math.ceil(seconds)} sec`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${Math.round(seconds % 60)} sec`;
  return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
}

export function formatClock(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.floor(seconds);
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  const hours = Math.floor(mins / 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(mins % 60)}:${pad(secs)}` : `${mins}:${pad(secs)}`;
}

export function formatPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Relative timestamp used in the history list: "Today · 14:32", "Yesterday · 09:10", "12 Mar". */
export function formatWhen(timestamp: number, now = Date.now()): string {
  const diff = startOfDay(now) - startOfDay(timestamp);
  const day = 24 * 60 * 60 * 1000;
  const time = new Date(timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (diff <= 0) return `Today · ${time}`;
  if (diff <= day) return `Yesterday · ${time}`;
  if (diff <= 6 * day) {
    return new Date(timestamp).toLocaleDateString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return new Date(timestamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}
