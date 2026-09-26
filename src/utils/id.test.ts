import { describe, expect, it } from 'vitest';
import idSource from './id.ts?raw';
import nameSource from './randomName.ts?raw';
import { generateRoomCode, randomFraction, randomIndex, randomPeerId, secureId } from './id';

/** Code lines only — the doc comments are allowed to mention Math.random. */
function codeLines(source: string): string {
  return source
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith('*') && !trimmed.startsWith('//') && !trimmed.startsWith('/*');
    })
    .join('\n');
}

describe('identifier utilities', () => {
  it('never leans on Math.random for identifiers', () => {
    // Guards against a regression that would make ids predictable.
    expect(codeLines(idSource)).not.toMatch(/Math\.random/);
    expect(codeLines(nameSource)).not.toMatch(/Math\.random/);
  });

  it('generates unambiguous room codes of the requested length', () => {
    const code = generateRoomCode(6);
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    expect(code).not.toMatch(/[0O1IL]/);
  });

  it('produces unique secure ids with an optional prefix', () => {
    const ids = new Set(Array.from({ length: 200 }, () => secureId('t')));
    expect(ids.size).toBe(200);
    for (const id of ids) {
      expect(id.startsWith('t-')).toBe(true);
      expect(id.length).toBeGreaterThan(10);
    }
  });

  it('keeps peer ids short, url-safe and unique enough', () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomPeerId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{6}$/);
  });

  it('bounds randomIndex and randomFraction', () => {
    for (let index = 0; index < 100; index += 1) {
      const value = randomIndex(5);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(5);
      const fraction = randomFraction();
      expect(fraction).toBeGreaterThanOrEqual(0);
      expect(fraction).toBeLessThan(1);
    }
    expect(randomIndex(0)).toBe(0);
  });
});
