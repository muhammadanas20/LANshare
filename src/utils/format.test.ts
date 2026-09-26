import { describe, expect, it } from 'vitest';
import { formatBytes, formatClock, formatDuration, formatEta, formatPercent, formatSpeed, formatWhen } from './format';

describe('formatBytes', () => {
  it('handles zero and invalid input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-5)).toBe('0 B');
    expect(formatBytes(Number.NaN)).toBe('0 B');
  });

  it('formats each unit with the expected precision', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1_488_000)).toBe('1.42 MB');
    expect(formatBytes(2_480_000_000)).toBe('2.31 GB');
    expect(formatBytes(35.2 * 1024 * 1024)).toBe('35.2 MB');
  });

  it('drops the decimal for larger kilobyte values', () => {
    expect(formatBytes(15 * 1024)).toBe('15 KB');
  });
});

describe('formatSpeed', () => {
  it('renders a per-second value and an em dash when idle', () => {
    expect(formatSpeed(0)).toBe('—');
    expect(formatSpeed(18.4 * 1024 * 1024)).toBe('18.4 MB/s');
  });
});

describe('formatDuration / formatEta', () => {
  it('formats durations', () => {
    expect(formatDuration(0.4)).toBe('< 1 sec');
    expect(formatDuration(2)).toBe('2 sec');
    expect(formatDuration(48)).toBe('48 sec');
    expect(formatDuration(72)).toBe('1 min 12 sec');
    expect(formatDuration(3720)).toBe('1 hr 2 min');
  });

  it('reports an unknown ETA instead of guessing', () => {
    expect(formatEta(null)).toBe('calculating…');
    expect(formatEta(8)).toBe('8 sec');
    expect(formatEta(0.2)).toBe('almost done');
    expect(formatEta(125)).toBe('2 min 5 sec');
  });
});

describe('formatClock', () => {
  it('formats media timecodes', () => {
    expect(formatClock(222)).toBe('3:42');
    expect(formatClock(3725)).toBe('1:02:05');
    expect(formatClock(null)).toBe('');
  });
});

describe('formatPercent', () => {
  it('clamps to 0..100 and rounds', () => {
    expect(formatPercent(0.6712 * 100)).toBe(67);
    expect(formatPercent(-1)).toBe(0);
    expect(formatPercent(180)).toBe(100);
    expect(formatPercent(Number.NaN)).toBe(0);
  });
});

describe('formatWhen', () => {
  it('labels today and yesterday', () => {
    const now = new Date('2026-09-25T15:00:00').getTime();
    const today = new Date('2026-09-25T09:30:00').getTime();
    const yesterday = new Date('2026-09-24T09:30:00').getTime();
    expect(formatWhen(today, now)).toContain('Today');
    expect(formatWhen(yesterday, now)).toContain('Yesterday');
  });
});
