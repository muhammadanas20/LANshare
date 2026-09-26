/**
 * Serverless pairing end-to-end — two devices, **no signaling server anywhere**.
 *
 * The app is served as plain static files (no `/ws` on the host at all), which is the real
 * situation this feature exists for: no computer running LANShare's server, no internet, or a
 * deployment where the backend simply is not reachable. The two devices nevertheless pair,
 * because the offer/answer exchange travels as a short text code that the user moves across
 * (a QR code in one direction, pasted text in the other) and the connection itself is a direct
 * WebRTC data channel over host candidates.
 *
 * What it proves, check by check: the app really is running *without* a server, the pairing
 * codes are produced and accepted, both devices end up in each other's device list, a real
 * file crosses the link, the downloaded bytes hash to the source, and nothing about the
 * session needs a network service.
 */
import { createHash, randomBytes } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '/tmp/lanshare-serverless';
const HTTP_PORT = Number(process.env.SERVERLESS_HTTP_PORT ?? 4197);
const BASE_URL = `http://127.0.0.1:${HTTP_PORT}/`;

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function waitFor(check, message, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${message}`);
    await sleep(120);
  }
}

async function waitForValue(check, message, timeout = 30_000) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${message}`);
    await sleep(120);
  }
}

/* ------------------------------------------------------------------ *
 * A deliberately dumb static host: files only, and no WebSocket route.
 * ------------------------------------------------------------------ */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function startStaticHost() {
  const dist = join(root, 'dist');
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://localhost:${HTTP_PORT}`);
    if (url.pathname === '/ws') {
      // The point of this suite: there is no signaling service here.
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'no_signaling_server' }));
      return;
    }
    let file = join(dist, decodeURIComponent(url.pathname));
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
    if (!existsSync(file)) file = join(dist, 'index.html');
    response.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
      'access-control-allow-origin': '*',
    });
    response.end(readFileSync(file));
  });
  server.listen(HTTP_PORT, '127.0.0.1');
  return server;
}

/**
 * Decode a pairing code the same way the app does, so the suite can report real numbers
 * (which encoding was chosen, and how big the session description was).
 */
function describeCode(code) {
  try {
    const compressed = code.startsWith('LS1.');
    const body = code.slice(compressed ? 4 : 5);
    const bytes = Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    // fflate produces raw DEFLATE (no zlib wrapper), so inflate raw here.
    const json = compressed ? inflateRawSync(bytes).toString('utf8') : bytes.toString('utf8');
    const parsed = JSON.parse(json);
    return {
      encoding: compressed ? 'deflate+base64' : 'base64 (json)',
      code: code.length,
      json: json.length,
      sdp: typeof parsed.sdp === 'string' ? parsed.sdp.length : 0,
    };
  } catch (error) {
    return { encoding: `unknown (${error.message.slice(0, 60)})`, code: code.length, json: 0, sdp: 0, head: code.slice(0, 6) };
  }
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

function appApi(page) {
  return {
    bodyText: () => page.evaluate(() => document.body.innerText),
    snapshot: () => page.evaluate(() => globalThis.__lanshare?.snapshot?.() ?? null),
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
    async clickButton(pattern) {
      const source = typeof pattern === 'string' ? pattern : pattern.source;
      return page.evaluate((src) => {
        const re = new RegExp(src);
        const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
          re.test(candidate.textContent?.trim() ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      }, source);
    },
    /** Open the serverless pairing dialog through the UI a user would use. */
    async openServerlessPairing() {
      await page.evaluate(() => {
        const button = document.querySelector('button[aria-label="Pair another device"]');
        button?.click();
      });
      await waitFor(
        () => page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Pair another device"]'))),
        'the pairing dialog',
      );
      const clicked = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Pair another device"]');
        const button = Array.from(dialog?.querySelectorAll('button') ?? []).find((candidate) =>
          /Pair with a code/i.test(candidate.textContent ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(clicked, 'the "pair with a code" action was not found in the pairing dialog');
      await waitFor(
        () => page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Pair without a server"]'))),
        'the serverless pairing dialog',
      );
    },
    readCode: (label) =>
      page.evaluate((aria) => document.querySelector(`textarea[aria-label="${aria}"]`)?.value ?? null, label),
    async fillCode(label, value) {
      const filled = await page.evaluate(
        ({ aria, text }) => {
          const field = document.querySelector(`textarea[aria-label="${aria}"]`);
          if (!field) return false;
          const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
          setter?.call(field, text);
          field.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        },
        { aria: label, text: value },
      );
      assert(filled, `the "${label}" field was not found`);
    },
    hasQr: (alt) => page.evaluate((needle) => Boolean(document.querySelector(`img[alt="${needle}"]`)), alt),
  };
}

async function main() {
  rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  if (!existsSync(join(root, 'dist', 'index.html'))) {
    console.log('dist/ is missing — build it first (`npm run build`).');
    process.exit(2);
  }

  const staticHost = startStaticHost();
  const puppeteer = loadPuppeteer();
  const fixture = join(ARTIFACT_DIR, 'serverless-payload.bin');
  const payloadBytes = randomBytes(768 * 1024);
  writeFileSync(fixture, payloadBytes);
  const sourceHash = createHash('sha256').update(payloadBytes).digest('hex');
  const downloadDir = join(ARTIFACT_DIR, 'downloads');
  mkdirSync(downloadDir, { recursive: true });

  console.log(`\nServerless pairing suite — static host only, no signaling service`);
  console.log(`  ${BASE_URL}\n`);

  const browser = await puppeteer.launch({
    headless: true,
    downloadsPath: downloadDir,
    protocolTimeout: 60_000,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  const contextA = await browser.createBrowserContext();
  const contextB = await browser.createBrowserContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  await pageA.setViewport({ width: 1280, height: 900 });
  await pageB.setViewport({ width: 390, height: 844 });
  const consoleErrors = [];
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      // Expected here: the app cannot reach /ws and the browser says so. That is the premise.
      if (/WebSocket connection to/i.test(text)) return;
      consoleErrors.push(`[${label}] ${text}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`[${label}] pageerror: ${error.message}`));
  }
  const a = appApi(pageA);
  const b = appApi(pageB);
  let inviteCode = '';
  let replyCode = '';

  try {
    await check('the app runs with no signaling service at all', async () => {
      await Promise.all([
        pageA.goto(`${BASE_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
        pageB.goto(`${BASE_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
      ]);
      await waitFor(async () => /Nearby devices/i.test(await a.bodyText()), 'the shell to render');
      const response = await fetch(`${BASE_URL}ws`);
      assert(response.status === 404, `expected the host to have no signaling route, saw ${response.status}`);
      // The app must be usable in this state, not stuck on a blocking error screen.
      for (const state of await Promise.all([a.snapshot(), b.snapshot()])) {
        assert(state && state.signalingState !== 'connected', 'signaling unexpectedly connected');
      }
    });

    await check('the first device produces an invite code and a QR image', async () => {
      await a.openServerlessPairing();
      assert(await a.clickButton('^Create a pairing code$'), 'the create-pairing-code action was not found');
      inviteCode = await waitForValue(() => a.readCode('Invite pairing code'), 'the invite code');
      assert(inviteCode.startsWith('LS1'), `unexpected invite format: ${inviteCode.slice(0, 12)}…`);
      assert(await a.hasQr('Invite pairing code as a QR code'), 'the invite QR image was not rendered');
      const described = describeCode(inviteCode);
      console.log(
        `        invite: ${described.code} chars (${described.encoding}) carrying a ${described.sdp}-byte description`,
      );
      assert(described.sdp > 0, `the invite code could not be decoded for inspection: ${described.encoding} (head ${described.head})`);
    });

    await check('the second device accepts it and produces a reply code', async () => {
      await b.openServerlessPairing();
      assert(await b.clickButton('I have a code'), 'the "I have a code" action was not found');
      await b.fillCode('Pairing code', inviteCode);
      assert(await b.clickButton('^Create reply code$'), 'the create-reply-code action was not found');
      replyCode = await waitForValue(() => b.readCode('Reply pairing code'), 'the reply code');
      assert(replyCode.startsWith('LS1'), `unexpected reply format: ${replyCode.slice(0, 12)}…`);
      assert(await b.hasQr('Reply pairing code as a QR code'), 'the reply QR image was not rendered');
      assert(replyCode !== inviteCode, 'the reply must be a distinct payload');
      const described = describeCode(replyCode);
      console.log(
        `        reply:  ${described.code} chars (${described.encoding}) carrying a ${described.sdp}-byte description`,
      );
      assert(described.sdp > 0, 'the reply code does not contain a usable session description');
    });

    await check('the first device applies the reply and both are paired', async () => {
      await a.fillCode('Reply code', replyCode);
      assert(await a.clickButton('^Connect$'), 'the connect action was not found');
      await waitFor(async () => /Paired with/i.test(await a.bodyText()), 'the paired confirmation', 30_000);
    });

    await check('both devices list each other without any server', async () => {
      await Promise.all([
        waitFor(async () => (await a.deviceNames()).length > 0, 'device A to list device B'),
        waitFor(async () => (await b.deviceNames()).length > 0, 'device B to list device A'),
      ]);
      console.log(`        A sees: ${JSON.stringify(await a.deviceNames())}`);
    });

    await check('a direct data channel opens on host candidates alone', async () => {
      try {
        await waitFor(
          async () => {
            const [stateA, stateB] = await Promise.all([a.snapshot(), b.snapshot()]);
            const live = (state) => Boolean(state?.links?.some((link) => link.ctl === 'open' && link.bin === 'open'));
            return live(stateA) && live(stateB);
          },
          'open ctl/bin channels on both sides',
          30_000,
        );
      } catch (error) {
        // ICE trouble is the one failure worth explaining in detail: which state machine stuck,
        // and whether either side ever gathered a candidate at all.
        const [stateA, stateB] = await Promise.all([a.snapshot(), b.snapshot()]);
        throw new Error(
          `${error.message}\n     A: ${JSON.stringify(stateA?.links)}\n     B: ${JSON.stringify(stateB?.links)}`,
        );
      }
      const state = await a.snapshot();
      assert(state?.peers?.length === 1, `expected exactly one peer, saw ${state?.peers?.length}`);
    });

    const peerNameOnA = (await a.deviceNames())[0];

    await check('a file transfers over the serverless link', async () => {
      await pageA.keyboard.press('Escape');
      await pageA.keyboard.press('Escape');
      const input = await pageA.$('input[type="file"]');
      assert(input, 'the file input was not found');
      await input.uploadFile(fixture);
      await waitFor(async () => /Selected files/i.test(await a.bodyText()), 'the queue to list the file');
      assert(await a.clickButton('^Send \\d+ files?$|^Send file$'), 'the send action was not found');
      await waitFor(
        () => pageA.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label^="Send files to"]'))),
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
      }, peerNameOnA);
      assert(targeted, `no send target for ${peerNameOnA}`);

      await waitFor(
        () => pageB.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Incoming transfer"]'))),
        'the incoming transfer dialog',
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
      assert(accepted, 'the accept action was not found');

      await waitFor(
        async () => {
          const state = await b.snapshot();
          return Boolean(state?.transfers?.some((t) => t.status === 'completed' && t.bytes === 768 * 1024));
        },
        'the receiver to report a completed 768 KiB transfer',
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
          item.textContent?.includes('serverless-payload.bin'),
        );
        const button = Array.from(row?.querySelectorAll('button') ?? []).find((candidate) =>
          /Download/.test(candidate.getAttribute('aria-label') ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(clicked, 'the download action was not found on the received file');
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

    await check('a malformed pairing code is refused with a clear message', async () => {
      const contextC = await browser.createBrowserContext();
      const pageC = await contextC.newPage();
      try {
        await pageC.goto(`${BASE_URL}?debug=1`, { waitUntil: 'domcontentloaded' });
        await waitFor(async () => /Nearby devices/i.test(await pageC.evaluate(() => document.body.innerText)), 'the shell');
        const c = appApi(pageC);
        await c.openServerlessPairing();
        await c.clickButton('I have a code');
        await c.fillCode('Pairing code', 'LS1.this-is-not-a-real-code');
        await c.clickButton('^Create reply code$');
        await waitFor(
          async () => /not a valid LANShare invite/i.test(await c.bodyText()),
          'the invalid-code message',
        );
      } finally {
        await pageC.close().catch(() => undefined);
        await contextC.close().catch(() => undefined);
      }
    });

    await check('neither browser logged an application error', async () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
    });
  } finally {
    await browser.close().catch(() => undefined);
    staticHost.close();
  }

  const passed = checks.filter((entry) => entry.ok).length;
  const failed = checks.filter((entry) => !entry.ok);
  writeFileSync(
    join(ARTIFACT_DIR, 'summary.json'),
    JSON.stringify({ checks, inviteCodeLength: inviteCode.length, replyCodeLength: replyCode.length }, null, 2),
  );
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`Serverless pairing result: ${passed}/${checks.length} checks passed`);
  if (failed.length) {
    for (const entry of failed) console.log(`  ✗ ${entry.name}: ${entry.error}`);
    console.log(`  artefacts kept for inspection: ${ARTIFACT_DIR}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
