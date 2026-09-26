/** Minimal structured logger. Never logs payload contents. */
import { serverConfig } from './config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[(process.env.LOG_LEVEL as Level) ?? (serverConfig.nodeEnv === 'production' ? 'info' : 'debug')] ?? 20;

function emit(level: Level, message: string, meta?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg: message,
    ...(meta ?? {}),
  };
  const serialised = JSON.stringify(line);
  if (level === 'error') process.stderr.write(`${serialised}\n`);
  else process.stdout.write(`${serialised}\n`);
}

export const log = {
  debug: (message: string, meta?: Record<string, unknown>) => emit('debug', message, meta),
  info: (message: string, meta?: Record<string, unknown>) => emit('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => emit('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => emit('error', message, meta),
};
