/**
 * Static file serving for offline mode.
 *
 * `npm run offline` runs one process that serves the built frontend *and* the signaling
 * WebSocket, so every other device on the LAN only needs a URL — no internet, no CDN, no
 * second server. The frontend build is a plain directory of files, so this stays small:
 * correct MIME types, cache headers that match Vite's hashed filenames, an SPA fallback,
 * and a path resolver that cannot escape the build directory.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Files that must never be cached: the HTML shell and the service worker change with every
 * deployment, and a stale copy of either is what makes a PWA keep serving an old build.
 */
const NO_CACHE = new Set(['index.html', 'sw.js', 'manifest.webmanifest', 'offline.html']);

export function contentTypeFor(filePath: string): string {
  return MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Map a request path to a file inside `root`, or `null` when the request must not be served.
 *
 * Rejects anything that resolves outside the root (including `..`, percent-encoded variants
 * after decoding, and absolute paths). The build directory is public, but a traversal bug
 * here would expose the whole disk of the machine hosting the LAN.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  // Normalise first so `/a/../../etc/passwd` collapses before the containment check.
  const relative = normalize(decoded).replace(/^([/\\])+/, '');
  if (relative.split(/[/\\]/).includes('..')) return null;
  const absoluteRoot = resolve(root);
  const target = resolve(join(absoluteRoot, relative));
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) return null;
  return target;
}

export interface StaticResult {
  status: number;
  filePath?: string;
  headers?: Record<string, string>;
}

/**
 * Decide how to answer a static request.
 *
 * - an existing file (or directory with an `index.html`) is served
 * - an unknown path *without* a file extension falls back to `index.html` (SPA routing)
 * - an unknown path *with* an extension is a 404 — a missing script must not answer with
 *   HTML, which is how "unexpected token <" breaks a deployed app
 */
export function planStaticRequest(root: string, urlPath: string): StaticResult {
  const target = resolveStaticPath(root, urlPath);
  if (!target) return { status: 403 };

  if (existsSync(target) && statSync(target).isDirectory()) {
    const index = join(target, 'index.html');
    if (existsSync(index)) {
      return { status: 200, filePath: index, headers: cacheHeaders('index.html', statSync(index).size) };
    }
    // Directory listing is never useful here.
    return { status: 404 };
  }

  if (existsSync(target) && statSync(target).isFile()) {
    return { status: 200, filePath: target, headers: cacheHeaders(target, statSync(target).size) };
  }

  if (extname(target) === '') {
    const index = join(resolve(root), 'index.html');
    if (existsSync(index)) {
      return { status: 200, filePath: index, headers: cacheHeaders('index.html', statSync(index).size) };
    }
  }
  return { status: 404 };
}

function cacheHeaders(filePath: string, size: number): Record<string, string> {
  const name = filePath.split(sep).pop() ?? '';
  return {
    'content-type': contentTypeFor(filePath),
    'content-length': String(size),
    'cache-control': NO_CACHE.has(name) ? 'no-cache' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    ...CORS_HEADERS,
  };
}

/**
 * The build directory is public, so any origin may read it. This matters for one concrete
 * case: an embedded/opaque-origin frame (a sandboxed iframe sends `Origin: null`) fetches
 * module scripts with CORS, and without this header the offline host would serve a page whose
 * own JavaScript the browser refuses to run.
 */
const CORS_HEADERS: Record<string, string> = { 'access-control-allow-origin': '*' };

export interface StaticHandlerOptions {
  root: string;
  /** Called when the request should fall through to the API routes. */
  next?: (request: IncomingMessage, response: ServerResponse) => void;
}

/**
 * Serve a request from the build directory. Returns `true` when the request was answered.
 */
export function serveStatic(options: StaticHandlerOptions, request: IncomingMessage, response: ServerResponse): boolean {
  const url = new URL(request.url ?? '/', 'http://localhost');
  const plan = planStaticRequest(options.root, url.pathname);

  if (plan.status !== 200 || !plan.filePath) {
    // A traversal attempt is not "not found" — say so, and do not leak the attempted path.
    const status = plan.status === 403 ? 403 : 404;
    response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...CORS_HEADERS });
    response.end(status === 403 ? 'forbidden' : 'not found');
    return true;
  }

  response.writeHead(200, plan.headers ?? {});
  if (request.method === 'HEAD') {
    response.end();
    return true;
  }
  const stream = createReadStream(plan.filePath);
  stream.on('error', () => {
    // The file disappeared between the stat and the read; answer instead of hanging.
    response.destroy();
  });
  stream.pipe(response);
  return true;
}
