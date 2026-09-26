import { describe, expect, it } from 'vitest';
import {
  clampText,
  firstUrl,
  isHttpUrl,
  linkifyText,
  normaliseRoomCode,
  safeMime,
  sanitizeFilename,
  sanitizeRelativePath,
  uniqueFilename,
  urlHost,
  validateFiles,
} from './validation';
import { config } from '../config';

function fileOf(name: string, size: number, type = 'application/octet-stream'): File {
  return new File([new Uint8Array(Math.min(size, 16))], name, { type });
}

// `File` size is derived from content in jsdom, so override it for size-limit tests.
function sizedFile(name: string, size: number, type = 'application/octet-stream'): File {
  const file = new File(['x'], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('sanitizeFilename', () => {
  it('strips directory components in both separator styles', () => {
    expect(sanitizeFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFilename('C:\\Users\\anas\\secret.txt')).toBe('secret.txt');
    expect(sanitizeFilename('/var/log/syslog')).toBe('syslog');
  });

  it('removes control characters and illegal characters', () => {
    expect(sanitizeFilename('re\u0000port<>:"|?*.pdf')).toBe('report_.pdf');
    expect(sanitizeFilename('line\nbreak.txt')).toBe('linebreak.txt');
  });

  it('neutralises reserved Windows device names and hidden files', () => {
    expect(sanitizeFilename('CON')).toBe('_CON');
    expect(sanitizeFilename('.hidden')).toBe('hidden');
    expect(sanitizeFilename('..')).toBe('file');
  });

  it('preserves the extension when clamping long names', () => {
    const long = `${'a'.repeat(400)}.png`;
    const result = sanitizeFilename(long);
    expect(result.length).toBeLessThanOrEqual(180);
    expect(result.endsWith('.png')).toBe(true);
  });

  it('falls back when the name is empty', () => {
    expect(sanitizeFilename('')).toBe('file');
    expect(sanitizeFilename('   ')).toBe('file');
  });
});

describe('sanitizeRelativePath', () => {
  it('keeps a safe folder prefix', () => {
    expect(sanitizeRelativePath('photos/2026/img.png', 'img.png')).toBe('photos/2026/img.png');
  });

  it('drops traversal segments', () => {
    expect(sanitizeRelativePath('../../evil/img.png', 'img.png')).toBe('evil/img.png');
    expect(sanitizeRelativePath('a/../b/img.png', 'img.png')).toBe('a/b/img.png');
  });

  it('returns nothing when there is no folder to preserve', () => {
    expect(sanitizeRelativePath('img.png', 'img.png')).toBeUndefined();
    expect(sanitizeRelativePath(undefined, 'img.png')).toBeUndefined();
  });
});

describe('uniqueFilename', () => {
  it('appends a counter before the extension', () => {
    const taken = new Set<string>();
    expect(uniqueFilename('report.pdf', taken)).toBe('report.pdf');
    expect(uniqueFilename('report.pdf', taken)).toBe('report (2).pdf');
    expect(uniqueFilename('report.pdf', taken)).toBe('report (3).pdf');
  });

  it('is case-insensitive', () => {
    const taken = new Set<string>();
    uniqueFilename('Photo.JPG', taken);
    expect(uniqueFilename('photo.jpg', taken)).toBe('photo (2).jpg');
  });
});

describe('URL handling', () => {
  it('accepts only http(s)', () => {
    expect(isHttpUrl('https://example.com')).toBe(true);
    expect(isHttpUrl('http://example.com')).toBe(true);
    expect(isHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isHttpUrl('data:text/html,<script>')).toBe(false);
    expect(isHttpUrl('file:///etc/passwd')).toBe(false);
  });

  it('detects the first URL and its host', () => {
    expect(firstUrl('see https://github.com/anas/lan-share now')).toBe('https://github.com/anas/lan-share');
    expect(firstUrl('no links here')).toBeNull();
    expect(firstUrl('try javascript:alert(1)')).toBeNull();
    expect(urlHost('https://www.github.com/x')).toBe('github.com');
  });

  it('splits text into renderable segments without executing anything', () => {
    const segments = linkifyText('open https://example.com and read');
    expect(segments).toEqual([
      { type: 'text', value: 'open ' },
      { type: 'url', value: 'https://example.com' },
      { type: 'text', value: ' and read' },
    ]);
  });

  it('trims trailing punctuation from links', () => {
    const segments = linkifyText('Visit https://example.com/docs.');
    expect(segments[1]).toEqual({ type: 'url', value: 'https://example.com/docs' });
  });
});

describe('normaliseRoomCode', () => {
  it('uppercases and strips unsafe characters', () => {
    expect(normaliseRoomCode('ab12cd')).toBe('AB12CD');
    expect(normaliseRoomCode(' 7f4k-2q ')).toBe('7F4K-2Q');
  });

  it('rejects codes that are too short or empty', () => {
    expect(normaliseRoomCode('')).toBeNull();
    expect(normaliseRoomCode(null)).toBeNull();
    expect(normaliseRoomCode('a')).toBeNull();
  });
});

describe('safeMime', () => {
  it('keeps valid mime types and falls back otherwise', () => {
    expect(safeMime('image/JPEG')).toBe('image/jpeg');
    expect(safeMime('not-a-mime')).toBe('application/octet-stream');
    expect(safeMime(undefined)).toBe('application/octet-stream');
  });
});

describe('clampText', () => {
  it('truncates beyond the configured limit', () => {
    const long = 'a'.repeat(20);
    expect(clampText(long, 5)).toContain('truncated');
    expect(clampText('short', 100)).toBe('short');
  });
});

describe('validateFiles', () => {
  it('accepts arbitrary types — no mime restrictions', () => {
    const result = validateFiles([fileOf('a.bin', 10), fileOf('b.xyz', 10, ''), fileOf('c.png', 10, 'image/png')]);
    expect(result.accepted).toHaveLength(3);
    expect(result.issues).toHaveLength(0);
  });

  it('rejects files above the configured single-file limit', () => {
    const huge = sizedFile('huge.bin', config.maxSingleFileBytes + 1);
    const result = validateFiles([huge]);
    expect(result.accepted).toHaveLength(0);
    expect(result.issues[0]?.reason).toMatch(/larger than the supported limit/);
  });

  it('caps the number of files in a transfer', () => {
    const files = Array.from({ length: config.maxFileCount + 3 }, (_, index) => fileOf(`f${index}.txt`, 4, 'text/plain'));
    const result = validateFiles(files, 0);
    expect(result.accepted).toHaveLength(config.maxFileCount);
    expect(result.issues.at(-1)?.reason).toMatch(/up to/);
  });

  it('counts already-queued files towards the cap', () => {
    const files = Array.from({ length: 3 }, (_, index) => fileOf(`f${index}.txt`, 4, 'text/plain'));
    const result = validateFiles(files, config.maxFileCount - 1);
    expect(result.accepted).toHaveLength(1);
  });
});
