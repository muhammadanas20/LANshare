/**
 * LANShare deployment-shape test (GitHub Pages style).
 *
 * The other suites all run the app the way development does: served from `/`, with the
 * signaling WebSocket proxied through the same origin. A real deployment looks different:
 *
 *   · the frontend is static files under a sub-path  (`VITE_BASE_PATH=/lan-share/`)
 *   · it talks to a signaling server on a *different origin* (`VITE_SIGNALING_URL=ws://…`)
 *   · that server only accepts connections from allowed origins (`ALLOWED_ORIGINS`)
 *
 * Every one of those is a place where a deployment quietly breaks: wrong asset URLs, a
 * service worker scoped to the wrong path, a manifest that 404s, a socket refused by the
 * allow-list. This script builds that exact combination into a throwaway directory, serves
 * it the way a static host would, and drives it in two browsers.
 *
 * Requires `puppeteer` (dev dependency or PUPPETEER_PATH). Builds the frontend itself, so it
 * does not touch the normal `dist/` output.
 *
 * Usage: node scripts/e2e/pages-deploy.mjs
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SIGNALING_PORT = Number(process.env.PAGES_SIGNALING_PORT ?? 8092);
const PAGES_PORT = Number(process.env.PAGES_HTTP_PORT ?? 4199);
const BASE_PATH = process.env.PAGES_BASE_PATH ?? '/lan-share/';
const ORIGIN = `http://localhost:${PAGES_PORT}`;
const APP_URL = `${ORIGIN}${BASE_PATH}`;

process.env.PUPPETEER_CACHE_DIR ??= join(homedir(), '.cache', 'puppeteer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failures = 0;
const results = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, error: error?.message ?? String(error) });
    console.error(`  ✗ ${name}\n     ${error?.message ?? error}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, message, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${message}`);
    await sleep(250);
  }
}

function loadPuppeteer() {
  const candidates = [process.env.PUPPETEER_PATH, 'puppeteer', '/tmp/node_modules/puppeteer'].filter(Boolean);
  const errors = [];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Puppeteer is required.\nTried:\n  ${errors.join('\n  ')}`);
}

/**
 * Enable downloads for one browser context. A page-session `Browser.setDownloadBehavior`
 * is silently ignored in isolated contexts — the command needs the context id from the
 * browser-level session.
 */
async function withDownloadCapture(page, directory, fn) {
  const browserSession = await page.browser().target().createCDPSession();
  const pageSession = await page.createCDPSession();
  const { targetInfo } = await pageSession.send('Target.getTargetInfo');
  await browserSession.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: directory,
    eventsEnabled: true,
    ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
  });
  try {
    return await fn();
  } finally {
    await pageSession.detach().catch(() => undefined);
    await browserSession.detach().catch(() => undefined);
  }
}

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** A minimal static host that mounts the build under BASE_PATH, like GitHub Pages does. */
function serveStatic(root, basePath, port) {
  const prefix = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${port}`);
    let pathname = decodeURIComponent(url.pathname);
    if (!pathname.startsWith(prefix)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    pathname = pathname.slice(prefix.length) || '/';
    // SPA fallback, exactly as a Pages deployment behaves for unknown deep links.
    let file = join(root, normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!existsSync(file) || pathname === '/') file = join(root, 'index.html');
    if (!existsSync(file)) {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
      return;
    }
    const body = readFileSync(file);
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'service-worker-allowed': prefix,
    });
    response.end(body);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function main() {
  console.log('\nLANShare deployment-shape test (Pages-style sub-path + cross-origin signaling)');
  console.log('────────────────────────────────────────────────────────────────────────────');

  const puppeteer = loadPuppeteer();
  // A failing run keeps its build for inspection, so prune builds left by older runs.
  try {
    for (const entry of (await import('node:fs')).readdirSync(tmpdir())) {
      if (entry.startsWith('lanshare-pages-')) {
        rmSync(join(tmpdir(), entry), { recursive: true, force: true });
      }
    }
  } catch {
    /* nothing to prune */
  }
  const buildDir = mkdtempSync(join(tmpdir(), 'lanshare-pages-'));
  const scratchDir = mkdtempSync(join(tmpdir(), 'lanshare-pages-scratch-'));
  const downloadDir = mkdtempSync(join(tmpdir(), 'lanshare-pages-downloads-'));
  // Chromium initialises its default download folder on launch even with `downloadsPath`
  // set; remove it again when this run is what created it.
  const defaultDownloadsDir = join(homedir(), 'Downloads');
  const defaultDownloadsExisted = existsSync(defaultDownloadsDir);
  const children = [];
  const cleanup = () => {
    for (const child of children) {
      try {
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', cleanup);

  let server = null;
  let browser = null;
  let signaling = null;

  try {
    /* -------------------------- 1. the deployment build -------------------------- */
    await check('the app builds for a sub-path deployment with a cross-origin signaling URL', async () => {
      execFileSync(
        'npx',
        ['vite', 'build', '--outDir', buildDir, '--emptyOutDir', '--logLevel', 'warn'],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            VITE_BASE_PATH: BASE_PATH,
            VITE_SIGNALING_URL: `ws://127.0.0.1:${SIGNALING_PORT}/ws`,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      assert(existsSync(join(buildDir, 'index.html')), 'the build produced no index.html');
      const html = readFileSync(join(buildDir, 'index.html'), 'utf8');
      const assetRefs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]);
      const scripts = assetRefs.filter((ref) => ref.endsWith('.js') || ref.includes('.js?'));
      assert(scripts.length > 0, 'the built HTML references no scripts');
      const absolute = assetRefs.filter((ref) => /^\/[^/]/.test(ref));
      assert(
        absolute.every((ref) => ref.startsWith(BASE_PATH)),
        `asset URLs ignore the base path: ${absolute.filter((ref) => !ref.startsWith(BASE_PATH)).join(', ')}`,
      );
      assert(
        !html.includes('"/assets/'),
        'the built HTML still points at root-absolute /assets/ URLs',
      );
      const serviceWorker = readFileSync(join(buildDir, 'sw.js'), 'utf8');
      assert(serviceWorker.length > 0, 'sw.js missing from the build');
    });

    /* ---------------------- 2. the signaling server + allow-list ---------------------- */
    await check('the signaling server accepts the deployment origin and rejects others', async () => {
      signaling = spawn('node', [join(ROOT, 'server', 'dist', 'index.js')], {
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          PORT: String(SIGNALING_PORT),
          HOST: '127.0.0.1',
          NODE_ENV: 'production',
          LOG_LEVEL: 'warn',
          // Exactly what an operator must configure for a Pages frontend.
          ALLOWED_ORIGINS: ORIGIN,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(signaling);
      let log = '';
      signaling.stdout.on('data', (chunk) => (log += String(chunk)));
      signaling.stderr.on('data', (chunk) => (log += String(chunk)));
      await waitFor(
        async () => {
          try {
            return (await fetch(`http://127.0.0.1:${SIGNALING_PORT}/health`)).ok;
          } catch {
            return false;
          }
        },
        'the signaling server to start',
      );

      // Negative control: a disallowed origin must not get a socket at all (the upgrade is
      // refused with 403 before the WebSocket handshake completes).
      const WebSocket = require('ws');
      const outcome = await new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}/ws`, { origin: 'http://evil.example' });
        const timer = setTimeout(() => resolve({ state: 'timeout' }), 5000);
        socket.on('open', () => {
          clearTimeout(timer);
          socket.close();
          resolve({ state: 'opened' });
        });
        socket.on('unexpected-response', (_request, response) => {
          clearTimeout(timer);
          resolve({ state: 'refused', status: response.statusCode });
        });
        socket.on('error', (error) => {
          clearTimeout(timer);
          resolve({ state: 'error', message: error.message });
        });
      });
      assert(outcome.state !== 'opened', 'the origin allow-list let a disallowed origin open a socket');
      assert(outcome.state !== 'timeout', 'the origin allow-list left a disallowed origin hanging');
      assert(
        outcome.status === 403 || outcome.state === 'error',
        `expected the upgrade to be refused, saw ${JSON.stringify(outcome)}`,
      );
      // stdout arrives in chunks slightly after the refusal — give it a moment.
      await waitFor(async () => /rejected origin/i.test(log), 'the rejection to be logged', 3000).catch(() => {
        throw new Error('the rejection was not logged');
      });

      // The allowed origin still gets a working socket (proved end-to-end by the browser
      // checks below, but assert the wire-level handshake here too).
      const accepted = await new Promise((resolve) => {
        const socket = new WebSocket(`ws://127.0.0.1:${SIGNALING_PORT}/ws`, { origin: ORIGIN });
        const timer = setTimeout(() => resolve(false), 5000);
        socket.on('open', () => {
          clearTimeout(timer);
          socket.close();
          resolve(true);
        });
        socket.on('error', () => {
          clearTimeout(timer);
          resolve(false);
        });
      });
      assert(accepted, 'the configured origin was refused');
    });

    /* --------------------------- 3. the static host --------------------------- */
    server = await serveStatic(buildDir, BASE_PATH, PAGES_PORT);

    await check('the static host serves the app under the deployment base path', async () => {
      const response = await fetch(APP_URL);
      assert(response.ok, `${APP_URL} returned HTTP ${response.status}`);
      const html = await response.text();
      assert(html.includes('LANShare'), 'the served HTML is not the app shell');
      const notFound = await fetch(`${ORIGIN}/index.html`);
      assert(notFound.status === 404, 'the app is reachable outside its base path (Pages would not serve that)');
    });

    /* ------------------------------ 4. in the browser ------------------------------ */
    const requests = [];
    const consoleErrors = [];
    browser = await puppeteer.launch({
      headless: true,
      downloadsPath: downloadDir,
      protocolTimeout: 45_000,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    const contextA = await browser.createBrowserContext();
    const contextB = await browser.createBrowserContext();
    const pageA = await contextA.newPage();
    const pageB = await contextB.newPage();
    for (const [label, page] of [
      ['A', pageA],
      ['B', pageB],
    ]) {
      await page.setViewport({ width: 1280, height: 900 });
      page.on('response', (response) => {
        if (response.status() >= 400) requests.push(`[${label}] ${response.status()} ${response.url()}`);
      });
      page.on('requestfailed', (request) => requests.push(`[${label}] failed ${request.url()} (${request.failure()?.errorText})`));
      page.on('console', (message) => {
        if (message.type() === 'error') consoleErrors.push(`[${label}] ${message.text()}`);
      });
      page.on('pageerror', (error) => consoleErrors.push(`[${label}] pageerror: ${error.message}`));
    }

    const dismissOnboarding = async (page) => {
      for (let i = 0; i < 24; i += 1) {
        const clicked = await page
          .evaluate(() => {
            const button = Array.from(document.querySelectorAll('button')).find(
              (candidate) => /^Continue$/.test(candidate.textContent?.trim() ?? ''),
            );
            if (!button) return false;
            button.click();
            return true;
          })
          .catch(() => false);
        if (clicked) return;
        await sleep(250);
      }
    };
    const bodyText = (page) => page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
    const snapshot = (page) =>
      page.evaluate(() => {
        const state = globalThis.__lanshare?.snapshot?.();
        return state
          ? {
              signalingState: state.signalingState,
              selfId: state.selfId,
              links: (state.links ?? []).map((link) => ({ ctl: link.ctl, bin: link.bin })),
            }
          : null;
      });

    await check('two browsers on the deployed build discover each other over the allowed origin', async () => {
      await Promise.all([
        pageA.goto(`${APP_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
        pageB.goto(`${APP_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
      ]);
      await Promise.all([dismissOnboarding(pageA), dismissOnboarding(pageB)]);
      await waitFor(async () => {
        const [stateA, stateB] = await Promise.all([snapshot(pageA), snapshot(pageB)]);
        const open = (state) => Boolean(state && state.links.some((link) => link.ctl === 'open' && link.bin === 'open'));
        return open(stateA) && open(stateB);
      }, 'both deployed pages to open a data channel', 40_000);
      // The socket really went to the other origin: the app must not be showing a
      // "no connection service" style banner.
      const text = await bodyText(pageA);
      assert(!/No connection service configured/i.test(text), 'the app fell back to “no signaling server”');
      assert(/Connected/i.test(text), 'no connected device shown on the deployed page');
    });

    await check('a file transfers intact on the deployed build', async () => {
      const payload = Buffer.alloc(512 * 1024);
      for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 17) % 256;
      const filePath = join(scratchDir, 'deployed-payload.bin');
      writeFileSync(filePath, payload);
      const expectedHash = createHash('sha256').update(payload).digest('hex');

      const input = await pageA.$('input[type="file"]');
      assert(input, 'file input not found on the deployed page');
      await input.uploadFile(filePath);
      // Same interaction the main suite uses: the queue's own send button opens the device
      // picker, where the first device row is chosen.
      const queued = await pageA.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
          /^Send \d+ files?$|^Send file$/.test(candidate.textContent?.trim() ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(queued, 'the queue send button did not appear on the deployed page');
      await pageA.waitForSelector('[role="dialog"]', { timeout: 10_000 });
      await waitFor(async () => {
        const text = await pageA.evaluate(() => {
          const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((candidate) =>
            /^Send (files|text) to/.test(candidate.getAttribute('aria-label') ?? ''),
          );
          return dialog?.textContent ?? null;
        });
        return Boolean(text);
      }, 'the device picker', 15_000);
      const picked = await pageA.evaluate(() => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((candidate) =>
          /^Send (files|text) to/.test(candidate.getAttribute('aria-label') ?? ''),
        );
        const button = Array.from(dialog?.querySelectorAll('button') ?? []).find(
          (candidate) => !candidate.disabled && /Send|Open/i.test(candidate.textContent ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(picked, 'no device could be picked in the send dialog');
      await waitFor(async () => /Accept/.test(await bodyText(pageB)), 'the incoming transfer dialog', 30_000);
      await pageB.evaluate(() => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (candidate) => candidate.getAttribute('aria-label') === 'Incoming transfer',
        );
        const button = Array.from(dialog?.querySelectorAll('button') ?? []).find((candidate) =>
          /^Accept/.test(candidate.textContent?.trim() ?? ''),
        );
        button?.click();
      });
      await waitFor(async () => /deployed-payload\.bin/.test(await bodyText(pageB)), 'the received file row', 40_000);
      await waitFor(
        async () => /Completed/.test(await bodyText(pageB)),
        'the transfer to complete',
        40_000,
      );
      // Download it and compare bytes.
      const { readdirSync } = await import('node:fs');
      const before = new Set(readdirSync(downloadDir));
      const downloadPath = await withDownloadCapture(pageB, downloadDir, async () => {
        const clicked = await pageB.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('li'));
          const row = rows.find((item) => item.textContent?.includes('deployed-payload.bin'));
          const button = Array.from(row?.querySelectorAll('button') ?? []).find((candidate) =>
            /Download/.test(candidate.getAttribute('aria-label') ?? ''),
          );
          if (!button) return false;
          button.click();
          return true;
        });
        assert(clicked, 'download button missing for the received file');
        return waitFor(async () => {
          const added = readdirSync(downloadDir).filter(
            (name) => !before.has(name) && !name.endsWith('.crdownload'),
          );
          if (added.length === 0) return null;
          const path = join(downloadDir, added[0]);
          // Wait for the file to stop growing before hashing it.
          let previous = -1;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const size = existsSync(path) ? readFileSync(path).length : 0;
            if (size > 0 && size === previous) return path;
            previous = size;
            await sleep(100);
          }
          return path;
        }, 'the download to land', 30_000);
      });
      const hash = createHash('sha256').update(readFileSync(downloadPath)).digest('hex');
      assert(hash === expectedHash, 'the received file does not match the sent bytes');
    });

    await check('the service worker is scoped to the deployed base path', async () => {
      const registration = await pageA.evaluate(async () => {
        const ready = await navigator.serviceWorker.ready.catch(() => null);
        const scope = ready?.scope ? new URL(ready.scope).pathname : null;
        return { scope, controller: Boolean(navigator.serviceWorker.controller) };
      });
      assert(registration.scope, 'no service worker registration on the deployed build');
      assert(
        registration.scope.startsWith(BASE_PATH),
        `the service worker is scoped to ${registration.scope}, outside ${BASE_PATH}`,
      );
    });

    await check('the manifest and icons resolve under the base path', async () => {
      const manifestHref = await pageA.evaluate(
        () => document.querySelector('link[rel="manifest"]')?.getAttribute('href') ?? null,
      );
      assert(manifestHref, 'no manifest link in the deployed page');
      const manifestUrl = new URL(manifestHref, APP_URL).toString();
      const response = await fetch(manifestUrl);
      assert(response.ok, `the manifest 404s at ${manifestUrl} (HTTP ${response.status})`);
      const manifest = await response.json();
      assert(manifest.name?.includes('LANShare'), 'the manifest has no app name');
      assert(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'the manifest lists no icons');
      for (const icon of manifest.icons) {
        const iconUrl = new URL(icon.src, manifestUrl).toString();
        const iconResponse = await fetch(iconUrl);
        assert(iconResponse.ok, `icon ${icon.src} 404s (HTTP ${iconResponse.status})`);
      }
    });

    await check('nothing 404s and the console stays clean on the deployed build', async () => {
      const failed = requests.filter((entry) => !entry.includes('/favicon.ico'));
      assert(failed.length === 0, `failed requests:\n     ${failed.join('\n     ')}`);
      const errors = consoleErrors.filter((entry) => !/favicon/i.test(entry));
      assert(errors.length === 0, `console errors:\n     ${errors.join('\n     ')}`);
    });
  } finally {
    if (browser) await browser.close().catch(() => undefined);
    if (server) await new Promise((resolve) => server.close(resolve));
    cleanup();
    await sleep(300);
    if (!defaultDownloadsExisted) {
      try {
        rmdirSync(defaultDownloadsDir);
      } catch {
        /* not empty or already gone — leave it alone */
      }
    }
    const keep = failures > 0;
    if (!keep) {
      rmSync(scratchDir, { recursive: true, force: true });
      rmSync(downloadDir, { recursive: true, force: true });
      rmSync(buildDir, { recursive: true, force: true });
    } else {
      console.error(`\n  build kept for inspection: ${buildDir}`);
    }
  }

  console.log('\n────────────────────────────────────────────────────────────────────────────');
  const passed = results.filter((result) => result.ok).length;
  console.log(`Deployment-shape result: ${passed}/${results.length} checks passed`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed:`);
    for (const result of results.filter((entry) => !entry.ok)) console.error(`  ✗ ${result.name}\n     ${result.error}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(`\nDeployment-shape test failed: ${error?.stack ?? error}`);
    process.exit(1);
  });
