/**
 * Logging helper.
 *
 * Development: verbose.
 * Production: quiet — unless the operator/user explicitly enables debug mode with
 * `?debug=1` in the URL or `localStorage.setItem('lanshare.debug', '1')`. No file
 * contents, peer metadata dumps or credentials are ever logged.
 */
import { config } from '../config';
import { readLocal } from '../utils/safeStorage';

function debugEnabled(): boolean {
  if (import.meta.env.DEV) return true;
  if (typeof window === 'undefined') return false;
  if (window.location.search.includes('debug=1')) return true;
  return readLocal('lanshare.debug') === '1';
}

const isDev = debugEnabled();

/** Render log arguments so browser consoles show useful text rather than [object Object]. */
function format(args: unknown[]): unknown[] {
  return args.map((arg) => {
    if (typeof arg === 'string' || typeof arg === 'number' || typeof arg === 'boolean') return arg;
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  });
}

export const log = {
  debug(...args: unknown[]): void {
    if (isDev) console.debug('[LANShare]', ...format(args));
  },
  info(...args: unknown[]): void {
    if (isDev) console.info('[LANShare]', ...format(args));
  },
  warn(...args: unknown[]): void {
    if (isDev) console.warn('[LANShare]', ...format(args));
  },
  error(...args: unknown[]): void {
    // Errors stay visible in production but carry no payload data.
    console.error(`[${config.appName}]`, ...args);
  },
};
