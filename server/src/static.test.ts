/**
 * Static-serving tests for offline mode (`npm run offline` serves the built frontend from
 * the same process as the signaling WebSocket).
 *
 * The two things worth pinning here are the ones that would be security or availability bugs
 * rather than cosmetic ones: a path can never escape the build directory, and a missing
 * `*.js` is a 404 rather than the HTML shell (which is how a deployed app breaks with
 * "Unexpected token '<'" instead of a clear error).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { contentTypeFor, planStaticRequest, resolveStaticPath } from './static.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'lanshare-static-'));
  writeFileSync(join(root, 'index.html'), '<!doctype html><title>LANShare</title>');
  writeFileSync(join(root, 'sw.js'), 'self.addEventListener("fetch", () => {});');
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'assets', 'index-abc123.js'), 'console.log("app");');
  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'deep.txt'), 'deep');
  // A sibling of the root: the classic escape target for a traversal bug.
  writeFileSync(join(root, '..', `secret-${process.pid}.txt`), 'do not serve me');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(join(root, '..', `secret-${process.pid}.txt`), { force: true });
});

describe('resolveStaticPath', () => {
  it('resolves files inside the root', () => {
    expect(resolveStaticPath(root, '/index.html')).toBe(join(root, 'index.html'));
    expect(resolveStaticPath(root, '/assets/index-abc123.js')).toBe(join(root, 'assets', 'index-abc123.js'));
  });

  it('refuses to escape the root, in every encoding that matters', () => {
    const attempts = [
      '/../etc/passwd',
      '/../../etc/passwd',
      '/assets/../../etc/passwd',
      '/%2e%2e%2fetc%2fpasswd',
      '/..%2f..%2fetc%2fpasswd',
      '/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd',
      '/nested/../../../etc/passwd',
      '\\..\\..\\windows\\system32\\config\\sam',
    ];
    for (const attempt of attempts) {
      const resolved = resolveStaticPath(root, attempt);
      if (resolved !== null) {
        expect(resolved.startsWith(root)).toBe(true);
      }
    }
  });

  it('rejects malformed percent-encoding and null bytes rather than throwing', () => {
    expect(resolveStaticPath(root, '/%zz')).toBeNull();
    expect(resolveStaticPath(root, '/index.html%00.png')).toBeNull();
  });
});

describe('planStaticRequest', () => {
  it('serves an existing file with its MIME type and an immutable cache header', () => {
    const plan = planStaticRequest(root, '/assets/index-abc123.js');
    expect(plan.status).toBe(200);
    expect(plan.headers?.['content-type']).toBe('text/javascript; charset=utf-8');
    expect(plan.headers?.['cache-control']).toContain('immutable');
  });

  it('allows any origin to read the public build, so embedded frames can load the app', () => {
    // A sandboxed iframe has an opaque origin and fetches module scripts with CORS; without
    // this header the host would serve a page whose own JavaScript is blocked.
    expect(planStaticRequest(root, '/assets/index-abc123.js').headers?.['access-control-allow-origin']).toBe('*');
    expect(planStaticRequest(root, '/').headers?.['access-control-allow-origin']).toBe('*');
  });

  it('never caches the shell or the service worker', () => {
    expect(planStaticRequest(root, '/').headers?.['cache-control']).toBe('no-cache');
    expect(planStaticRequest(root, '/index.html').headers?.['cache-control']).toBe('no-cache');
    expect(planStaticRequest(root, '/sw.js').headers?.['cache-control']).toBe('no-cache');
  });

  it('falls back to the shell for extension-less routes (SPA navigation)', () => {
    expect(planStaticRequest(root, '/some/client/route').status).toBe(200);
    expect(planStaticRequest(root, '/some/client/route').filePath).toBe(join(root, 'index.html'));
  });

  it('404s a missing asset instead of answering with HTML', () => {
    const plan = planStaticRequest(root, '/assets/missing-xyz.js');
    expect(plan.status).toBe(404);
    expect(plan.filePath).toBeUndefined();
  });

  it('never serves a file outside the root, however the path is written', () => {
    // Normalisation happens before the containment check, so `/../secret.txt` collapses to
    // `/secret.txt` *inside* the root and simply is not there. The property that matters is
    // that the sibling file is unreachable — not which status code says so.
    const target = `secret-${process.pid}.txt`;
    for (const attempt of [`/../${target}`, `/%2e%2e%2f${target}`, `/nested/../../${target}`]) {
      const plan = planStaticRequest(root, attempt);
      expect(plan.filePath).not.toBe(join(root, '..', target));
      expect(plan.status).not.toBe(200);
    }
  });
});

describe('contentTypeFor', () => {
  it('maps the file types a Vite build actually emits', () => {
    expect(contentTypeFor('a.html')).toContain('text/html');
    expect(contentTypeFor('a.css')).toContain('text/css');
    expect(contentTypeFor('manifest.webmanifest')).toContain('manifest+json');
    expect(contentTypeFor('icon.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('icon-192.png')).toBe('image/png');
    expect(contentTypeFor('unknown.bin')).toBe('application/octet-stream');
  });
});
