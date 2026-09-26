/**
 * `npm run build:single` — turn the built app into ONE self-contained HTML file.
 *
 * Why this exists: the offline paths in this project need one of two things — a computer
 * running LANShare's server, or the app already present on both devices. This file removes
 * both conditions. It is the whole application (JavaScript, CSS, favicon) in a single
 * document, so it can be carried to a phone by USB, AirDrop, a chat attachment or email, and
 * opened with no install, no build step, no server and no internet. Two devices that each open
 * it can then pair with a code and transfer files directly.
 *
 * How it works: the app is built once with chunking disabled (`VITE_SINGLE_FILE=1`, see
 * vite.config.ts), then every `<script src>`/`<link rel=stylesheet>` reference is replaced by
 * the file's own contents. An inline module script cannot import siblings from `file://`, so
 * after this step the document must reference nothing at all — which the script asserts.
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD_DIR = join(root, 'dist-offline', 'single');
const OUT_FILE = join(root, 'dist-offline', 'LANShare.html');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function read(relativePath) {
  return readFileSync(join(BUILD_DIR, relativePath), 'utf8');
}

/** Inline every local `<script src>` and `<link rel="stylesheet">`, in document order. */
function inlineAssets(html) {
  let inlined = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (match, source) => {
    if (/^https?:\/\//i.test(source)) return match;
    const relative = source.replace(/^\.?\//, '');
    const code = read(relative);
    // A literal `</script>` inside the bundle would end the block early.
    const safe = code.replace(/<\/script>/gi, '<\\/script>');
    return `<script type="module">\n${safe}\n</script>`;
  });

  inlined = inlined.replace(/<link\b[^>]*rel="stylesheet"[^>]*>/g, (match) => {
    const href = /href="([^"]+)"/.exec(match)?.[1];
    if (!href || /^https?:\/\//i.test(href)) return match;
    return `<style>\n${read(href.replace(/^\.?\//, ''))}\n</style>`;
  });

  // Module preload hints point at files that no longer exist as siblings.
  inlined = inlined.replace(/<link\b[^>]*rel="modulepreload"[^>]*>\s*/g, '');

  // Icons and the web app manifest are separate files; replace them with tiny inline ones so
  // the document needs nothing from disk (and the browser's console stays clean).
  inlined = inlined.replace(/<link\b[^>]*\brel="(icon|apple-touch-icon|manifest)"[^>]*>\s*/g, '');
  const favicon =
    'data:image/svg+xml,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f6fdf"/><path d="M16 7l7 7h-4.5v11h-5V14H9z" fill="#fff"/></svg>',
    );
  inlined = inlined.replace('</head>', `  <link rel="icon" href="${favicon}" />\n  </head>`);

  // Social preview images are files too; they are meaningless offline.
  inlined = inlined.replace(/<meta\b[^>]*(og:image|twitter:image)[^>]*>\s*/g, '');

  return inlined;
}

/** Nothing may be fetched when the document is opened from disk. */
function findExternalReferences(html) {
  const references = [];
  for (const match of html.matchAll(/<(script|link|img)\b[^>]*\b(src|href)="([^"]+)"/g)) {
    const value = match[3] ?? '';
    if (/^(data:|blob:|#|mailto:|javascript:)/i.test(value)) continue;
    references.push(`${match[1]}:${value}`);
  }
  return references;
}

function main() {
  if (!readdirSync(root).includes('dist-offline')) {
    throw new Error('Run `npm run build:single` (this script) after a single-file build — dist-offline/ is missing.');
  }
  const indexPath = join(BUILD_DIR, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const inlined = inlineAssets(html);

  const external = findExternalReferences(inlined);
  assert(
    external.length === 0,
    `the single-file build still references external files (it would fail from file://):\n  ${external.join('\n  ')}`,
  );

  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, inlined);
  const size = statSync(OUT_FILE).size;
  console.log(`Single-file app written: ${OUT_FILE}`);
  console.log(`  ${(size / 1024).toFixed(0)} kB, no external references, opens from file://`);
}

main();
