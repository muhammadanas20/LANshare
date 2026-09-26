/**
 * Offline LAN end-to-end — the "no internet" sharing path.
 *
 * `npm run offline` runs one process that serves the built frontend *and* the signaling
 * WebSocket and advertises no external ICE servers. This suite proves the whole chain the
 * way a user experiences it:
 *
 *   host machine  →  serves the app on its LAN address
 *   other device  →  opens that address (a phone would scan the QR), appears in the list
 *   transfer      →  WebRTC data channel, bytes hashed on arrival
 *
 * …and it proves the "offline" claim the only way that means anything: by recording every
 * network request both browsers make and failing if *any* of them leaves the LAN origin.
 *
 * Two server shapes are covered: plain HTTP (transfers work, which is what most people
 * will use) and HTTPS with a self-signed certificate (needed only to install the app as a
 * PWA on a phone, because service workers require a secure context).
 *
 * Requires: a built `dist/` (builds one if missing), `openssl` for the HTTPS part,
 * and puppeteer (same resolution chain as the other suites).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '/tmp/lanshare-offline';
const HTTP_PORT = Number(process.env.OFFLINE_E2E_HTTP_PORT ?? 8094);
const HTTPS_PORT = Number(process.env.OFFLINE_E2E_HTTPS_PORT ?? 8095);

// `require` so the puppeteer resolution chain (dev dependency, PUPPETEER_PATH, /tmp) works
// from an ES module — same approach as the main e2e harness.
const require = createRequire(import.meta.url);

process.env.PUPPETEER_CACHE_DIR ??= join(process.env.HOME ?? '/home/user', '.cache', 'puppeteer');

function loadPuppeteer() {
  const errors = [];
  const candidates = [process.env.PUPPETEER_PATH, 'puppeteer', '/tmp/node_modules/puppeteer'].filter(Boolean);
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${error.message}`);
    }
  }
  throw new Error(`Puppeteer is required for the browser end-to-end test.\nTried:\n  ${errors.join('\n  ')}`);
}

function lanAddress() {
  const preferred = process.env.OFFLINE_E2E_HOST;
  if (preferred) return preferred;
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '127.0.0.1';
}

const LAN = lanAddress();
const ORIGIN = `http://${LAN}:${HTTP_PORT}`;
const SECURE_ORIGIN = `https://${LAN}:${HTTPS_PORT}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(check, message, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${message}`);
    await sleep(150);
  }
}

/** Like `waitFor`, but returns the first truthy value the callback produces. */
async function waitForValue(check, message, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${message}`);
    await sleep(150);
  }
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    child.on('error', reject);
  });
}

/** Start the signaling server the way `npm run offline` does, detached so it can be killed as a group. */
function startOfflineServer({ port, tls }) {
  const env = {
    ...process.env,
    PORT: String(port),
    HOST: '0.0.0.0',
    SERVE_STATIC: 'true',
    STATIC_ROOT: join(root, 'dist'),
    OFFLINE_MODE: 'true',
    SINGLE_FILE_PATH: join(root, 'dist-offline', 'LANShare.html'),
    ROOM_TTL_MS: '60000',
    ...(tls ? { TLS_CERT: tls.certPath, TLS_KEY: tls.keyPath } : { TLS_CERT: '', TLS_KEY: '' }),
  };
  const child = spawn('npx', ['tsx', 'src/index.ts'], {
    cwd: join(root, 'server'),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  const logs = [];
  const collect = (chunk) => {
    const text = String(chunk);
    logs.push(text);
    if (process.env.E2E_VERBOSE) process.stdout.write(`  [offline:${port}] ${text}`);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, logs };
}

function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  try {
    if (process.platform === 'win32') server.child.kill('SIGTERM');
    else process.kill(-server.child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
}

async function waitForHttp(url, timeout = 20_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status < 500) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${url}`);
    await sleep(250);
  }
}

/** Self-signed certificate with the LAN address in its SAN list (same shape `npm run cert` makes). */
function makeCertificate(directory) {
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '30', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=LANShare (offline e2e)',
      '-addext', `subjectAltName=DNS:localhost,IP:127.0.0.1,IP:${LAN}`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return { certPath, keyPath };
}

function appApi(page) {
  return {
    async bodyText() {
      return page.evaluate(() => document.body.innerText);
    },
    async snapshot() {
      return page.evaluate(() => globalThis.__lanshare?.snapshot?.() ?? null);
    },
    async deviceNames() {
      return page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('h2')).find((node) =>
          node.textContent?.includes('Nearby devices'),
        );
        const section = heading?.closest('section');
        if (!section) return [];
        return Array.from(section.querySelectorAll('li'))
          .map((item) => {
            const named = item.querySelector('button span[title]');
            if (named) return named.getAttribute('title') ?? '';
            return (item.querySelector('button')?.textContent?.trim() ?? '').replace(/[✓◌·].*$/, '').trim();
          })
          .filter(Boolean);
      });
    },
  };
}

const checks = [];
async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    checks.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    checks.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    console.log(`  ✗ ${name} (${Date.now() - started} ms)\n     ${error.message}`);
  }
}

async function main() {
  rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  if (!existsSync(join(root, 'dist', 'index.html'))) {
    console.log('dist/ is missing — building first…');
    await run('npm', ['run', 'build']);
  }
  if (!existsSync(join(root, 'dist-offline', 'LANShare.html'))) {
    console.log('the single-file app is missing — building it first…');
    await run('npm', ['run', 'build:single']);
  }

  let tls = null;
  try {
    tls = makeCertificate(ARTIFACT_DIR);
  } catch (error) {
    console.log(`  (openssl unavailable — the HTTPS checks will be skipped: ${error.message.split('\n')[0]})`);
  }

  const puppeteer = loadPuppeteer();
  const fixture = join(ARTIFACT_DIR, 'offline-payload.bin');
  const payload = randomBytes(1024 * 1024);
  writeFileSync(fixture, payload);
  const sourceHash = createHash('sha256').update(payload).digest('hex');
  const downloadDir = join(ARTIFACT_DIR, 'downloads');
  mkdirSync(downloadDir, { recursive: true });

  const http = startOfflineServer({ port: HTTP_PORT });
  const https = tls ? startOfflineServer({ port: HTTPS_PORT, tls }) : null;
  console.log(`\nOffline LAN suite — host is ${LAN}`);
  console.log(`  HTTP  ${ORIGIN}`);
  if (https) console.log(`  HTTPS ${SECURE_ORIGIN}`);
  console.log('');

  const externalRequests = [];
  const browser = await puppeteer.launch({
    headless: true,
    acceptInsecureCerts: true,
    downloadsPath: downloadDir,
    protocolTimeout: 60_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const contextA = await browser.createBrowserContext();
  const contextB = await browser.createBrowserContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await pageA.setViewport({ width: 1280, height: 900 });
  await pageB.setViewport({ width: 390, height: 844 }); // a phone-shaped receiver
  const consoleErrors = [];

  const record = (label) => (request) => {
    const url = request.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    const host = new URL(url).hostname;
    if (host !== LAN && host !== 'localhost' && host !== '127.0.0.1') {
      externalRequests.push(`[${label}] ${url}`);
    }
  };
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('request', record(label));
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // Chrome notices that a blob URL was loaded over an insecure origin. That *is* the
      // documented plain-HTTP LAN mode (transfers work; only PWA install needs HTTPS), so it
      // is called out here instead of being counted as an application error.
      if (/over an insecure connection/i.test(text)) return;
      consoleErrors.push(`[${label}] ${text}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`[${label}] pageerror: ${error.message}`));
  }
  const a = appApi(pageA);
  const b = appApi(pageB);

  try {
    await waitForHttp(`${ORIGIN}/health`);

    await check('the offline host serves the built app on its LAN address', async () => {
      const response = await pageA.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' });
      assert(response && response.status() === 200, `expected HTTP 200 from ${ORIGIN}, saw ${response?.status()}`);
      const served = await pageA.evaluate(() =>
        Array.from(document.querySelectorAll('script[src]')).map((script) => script.getAttribute('src') ?? ''),
      );
      assert(
        served.some((source) => /^\/assets\/index-[\w-]+\.js$/.test(source)),
        `expected the built bundle, saw ${JSON.stringify(served)}`,
      );
      await waitFor(async () => /Nearby devices/i.test(await a.bodyText()), 'the shell to render');
    });

    await check('the host advertises itself as an offline LAN deployment', async () => {
      await waitFor(
        async () => {
          const state = await a.snapshot();
          return Boolean(state && state.signalingState === 'connected');
        },
        'signalling to connect',
      );
      const badge = await pageA.evaluate(() => document.body.innerText.includes('Offline LAN'));
      assert(badge, 'the "Offline LAN" indicator is not visible on the host page');
    });

    await check('no external ICE servers are advertised (the LAN is the only network)', async () => {
      await waitFor(async () => (await a.snapshot()) !== null, 'the debug snapshot');
      const ice = await pageA.evaluate(() => globalThis.__lanshare?.iceServers?.() ?? null);
      assert(Array.isArray(ice), `expected an ICE server list, saw ${JSON.stringify(ice)}`);
      assert(ice.length === 0, `expected no ICE servers in offline mode, saw ${JSON.stringify(ice)}`);
    });

    await check('the pairing panel offers a scannable LAN join link', async () => {
      const opened = await pageA.evaluate(() => {
        const button = document.querySelector('button[aria-label="Pair another device"]');
        if (!button) return false;
        button.click();
        return true;
      });
      assert(opened, 'the pair-device button was not found');
      await waitFor(
        async () =>
          pageA.evaluate(() =>
            Boolean(document.querySelector('[role="dialog"][aria-label="Pair another device"]')),
          ),
        'the pairing dialog',
      );
      const panel = await pageA.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Pair another device"]');
        const image = Array.from(dialog?.querySelectorAll('img') ?? []).find((candidate) =>
          /opens this LANShare host/.test(candidate.getAttribute('alt') ?? ''),
        );
        return {
          text: dialog?.innerText ?? '',
          hasLanQr: Boolean(image),
          qrIsDataUrl: (image?.getAttribute('src') ?? '').startsWith('data:image/'),
        };
      });
      assert(/Offline LAN mode/i.test(panel.text), 'the offline LAN panel is missing from the dialog');
      assert(panel.text.includes(`${LAN}:${HTTP_PORT}`), `the LAN URL ${LAN}:${HTTP_PORT} is not shown`);
      assert(panel.hasLanQr && panel.qrIsDataUrl, 'the LAN join QR code was not rendered');
      await pageA.keyboard.press('Escape');
    });

    await check('a phone-shaped device opens the LAN address and finds the host', async () => {
      // `?debug=1` only exposes a read-only state hook for the suite; the user-facing path is
      // identical, and the checks below assert both the UI text and the real transport.
      await pageB.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' });
      await waitFor(async () => /Nearby devices/i.test(await b.bodyText()), 'the receiver shell to render');
      await pageB.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
          /^Continue$/.test(candidate.textContent?.trim() ?? ''),
        );
        button?.click();
      });
      await waitFor(async () => (await b.deviceNames()).length > 0, 'the phone to see the host');
      await waitFor(async () => (await a.deviceNames()).length > 0, 'the host to see the phone');
    });

    await check('a direct WebRTC data channel opens with no STUN and no internet', async () => {
      await waitFor(
        async () => {
          const [stateA, stateB] = await Promise.all([a.snapshot(), b.snapshot()]);
          const live = (state) =>
            Boolean(state?.links?.some((link) => link.ctl === 'open' && link.bin === 'open'));
          return live(stateA) && live(stateB);
        },
        'open ctl/bin channels on both sides',
      );
    });

    const phoneName = (await a.deviceNames())[0];

    await check('a file uploads from the host to the phone and arrives intact', async () => {
      const input = await pageA.$('input[type="file"]');
      assert(input, 'the file input was not found');
      await input.uploadFile(fixture);
      await waitFor(async () => /Selected files/i.test(await a.bodyText()), 'the queue to list the file');
      const opened = await pageA.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
          /^Send \d+ files?$|^Send file$/.test(candidate.textContent?.trim() ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(opened, 'the send button was not found');
      await waitFor(
        async () =>
          pageA.evaluate(() =>
            Boolean(document.querySelector('[role="dialog"][aria-label^="Send files to"]')),
          ),
        'the device picker',
      );
      const targeted = await pageA.evaluate((name) => {
        const dialog = document.querySelector('[role="dialog"][aria-label^="Send files to"]');
        const button = Array.from(dialog?.querySelectorAll('button') ?? []).find(
          (candidate) => candidate.textContent?.includes('Send') && candidate.closest('li')?.textContent?.includes(name),
        );
        if (!button) return false;
        button.click();
        return true;
      }, phoneName);
      assert(targeted, `no send target for ${phoneName}`);

      await waitFor(
        async () =>
          pageB.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Incoming transfer"]'))),
        'the incoming transfer dialog on the phone',
      );
      const accepted = await pageB.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Incoming transfer"]');
        const accept = Array.from(dialog?.querySelectorAll('button') ?? []).find((candidate) =>
          /^Accept/.test(candidate.textContent?.trim() ?? ''),
        );
        if (!accept) return false;
        accept.click();
        return true;
      });
      assert(accepted, 'the accept button was not found');

      await waitFor(
        async () => {
          const state = await b.snapshot();
          return Boolean(
            state?.transfers?.some((transfer) => transfer.status === 'completed' && transfer.bytes === 1024 * 1024),
          );
        },
        'the receiver to report a completed 1 MiB transfer',
        60_000,
      );
    });

    await check('the downloaded bytes hash to the source file', async () => {
      const browserSession = await pageB.browser().target().createCDPSession();
      const pageSession = await pageB.createCDPSession();
      const { targetInfo } = await pageSession.send('Target.getTargetInfo');
      await browserSession.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir,
        eventsEnabled: true,
        ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
      });
      const before = new Set(readdirSync(downloadDir));
      const clicked = await pageB.evaluate(() => {
        const row = Array.from(document.querySelectorAll('li')).find((item) =>
          item.textContent?.includes('offline-payload.bin'),
        );
        const button = Array.from(row?.querySelectorAll('button') ?? []).find((candidate) =>
          /Download/.test(candidate.getAttribute('aria-label') ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(clicked, 'the download button was not found on the received file');
      const landed = await waitForValue(
        async () => {
          const added = readdirSync(downloadDir).filter((name) => !before.has(name) && !name.endsWith('.crdownload'));
          if (added.length === 0) return null;
          const path = join(downloadDir, added[0]);
          let previous = -1;
          for (let attempt = 0; attempt < 60; attempt += 1) {
            const size = existsSync(path) ? statSync(path).size : 0;
            if (size > 0 && size === previous) return path;
            previous = size;
            await sleep(100);
          }
          return null;
        },
        'the download to land',
        30_000,
      );
      const receivedHash = createHash('sha256').update(readFileSync(landed)).digest('hex');
      assert(receivedHash === sourceHash, `hash mismatch: ${receivedHash.slice(0, 16)}… vs ${sourceHash.slice(0, 16)}…`);
      await pageSession.detach().catch(() => undefined);
      await browserSession.detach().catch(() => undefined);
    });

    await check('nothing left the LAN: every request stayed on the host address', async () => {
      assert(
        externalRequests.length === 0,
        `requests to hosts outside the LAN: ${externalRequests.slice(0, 5).join(', ')}`,
      );
    });

    await check('neither browser logged a console error', async () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
    });

    if (https) {
      await check('the HTTPS variant (PWA-install capable) serves and connects too', async () => {
        const response = await pageA.goto(`${SECURE_ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' });
        assert(response && response.status() === 200, `expected HTTP 200 over TLS, saw ${response?.status()}`);
        const secure = await pageA.evaluate(() => window.isSecureContext);
        assert(secure, 'the TLS origin is not a secure context, so a service worker could not register');
        await waitFor(
          async () => {
            const state = await a.snapshot();
            return Boolean(state && state.signalingState === 'connected');
          },
          'signalling to connect over TLS',
        );
        const sw = await pageA.evaluate(() => navigator.serviceWorker.getRegistration().then((r) => Boolean(r)));
        assert(sw, 'the service worker did not register on the HTTPS origin (offline shell unavailable)');
      });
    }

    await check('the host offers the single-file app for devices that want to work alone later', async () => {
      const info = await fetch(`${ORIGIN}/single-file.json`).then((response) => response.json());
      assert(info.available === true, 'the host does not report a single-file build as available');

      const response = await fetch(`${ORIGIN}${info.path}`);
      assert(response.status === 200, `the single-file download answered ${response.status}`);
      assert(
        (response.headers.get('content-disposition') ?? '').includes('LANShare.html'),
        'the download is not named LANShare.html',
      );
      const html = await response.text();
      // It must be the whole app, self-contained: no external references at all.
      const external = [...html.matchAll(/<(script|link|img)\b[^>]*\b(src|href)="([^"]+)"/g)]
        .map((match) => match[3])
        .filter((value) => !/^(data:|blob:|#|mailto:|javascript:)/i.test(value ?? ''));
      assert(external.length === 0, `the downloaded app references external files: ${external.slice(0, 4).join(', ')}`);
      assert(/<div id="root">/.test(html), 'the download is not the app shell');
      console.log(`        single-file app: ${(html.length / 1024).toFixed(0)} kB, no external references`);
    });

    await check('the offline server still refuses to serve files outside the build directory', async () => {
      for (const path of ['/../package.json', '/%2e%2e%2fpackage.json', '/assets/../../package.json']) {
        const response = await fetch(`${ORIGIN}${path}`);
        assert(response.status === 403 || response.status === 404, `${path} answered ${response.status}`);
        const body = await response.text();
        assert(!body.includes('"dependencies"'), `${path} leaked the repository's package.json`);
      }
    });
  } finally {
    await browser.close().catch(() => undefined);
    stopServer(http);
    stopServer(https);
  }

  const passed = checks.filter((entry) => entry.ok).length;
  const failed = checks.filter((entry) => !entry.ok);
  writeFileSync(
    join(ARTIFACT_DIR, 'summary.json'),
    JSON.stringify({ lan: LAN, httpPort: HTTP_PORT, httpsPort: tls ? HTTPS_PORT : null, checks }, null, 2),
  );
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`Offline LAN result: ${passed}/${checks.length} checks passed`);
  if (failed.length) {
    for (const entry of failed) console.log(`  ✗ ${entry.name}: ${entry.error}`);
    console.log(`  artefacts kept for inspection: ${ARTIFACT_DIR}`);
  } else {
    rmSync(downloadDir, { recursive: true, force: true });
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
