/**
 * Single-file app end-to-end — the "no install, no server, no internet" path.
 *
 * `npm run build:single` produces one self-contained HTML file (JavaScript, CSS and icons
 * inlined). This suite opens that file **straight from disk** (`file://`) in two browser
 * contexts, which is what happens when somebody carries the file to a phone by USB, AirDrop or
 * a chat attachment, and asserts the whole journey: the app boots, it honestly reports that
 * there is no connection service, two devices pair with a code, a real file crosses the direct
 * data channel, and the downloaded bytes hash to the source.
 *
 * It also asserts *nothing is fetched over the network at all* — the document must reference
 * no external file, which is the difference between "works offline" and "works with the internet
 * switched off".
 */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const require = createRequire(import.meta.url);
const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const ARTIFACT_DIR = process.env.E2E_ARTIFACT_DIR ?? '/tmp/lanshare-single-file';
const SINGLE_FILE = join(root, 'dist-offline', 'LANShare.html');
const PAGE_URL = `file://${SINGLE_FILE}`;

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

function checkRunner() {
  const results = [];
  return {
    results,
    async check(name, fn) {
      const started = Date.now();
      try {
        await fn();
        results.push({ name, ok: true, ms: Date.now() - started });
        console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
      } catch (error) {
        results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
        console.log(`  ✗ ${name} (${Date.now() - started} ms)\n     ${error.message}`);
      }
    },
  };
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
    async openServerlessPairing() {
      // From the honest "no connection service" banner, which is what a file:// page shows.
      const opened = await page.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
          /Pair without a server/i.test(candidate.textContent ?? ''),
        );
        if (button) {
          button.click();
          return 'banner';
        }
        const pair = document.querySelector('button[aria-label="Pair another device"]');
        pair?.click();
        return pair ? 'dialog' : null;
      });
      assert(opened, 'no way to reach the serverless pairing flow was found');
      if (opened === 'dialog') {
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
        assert(clicked, 'the "pair with a code" action was not found');
      }
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
  };
}

async function main() {
  rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  if (!existsSync(SINGLE_FILE)) {
    console.log('dist-offline/LANShare.html is missing — building the single-file app first…');
    await new Promise((resolve, reject) => {
      const child = spawn('npm', ['run', 'build:single'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build:single exited with ${code}`))));
    });
  }

  const puppeteer = loadPuppeteer();
  const fixture = join(ARTIFACT_DIR, 'single-file-payload.bin');
  const payload = randomBytes(512 * 1024);
  writeFileSync(fixture, payload);
  const sourceHash = createHash('sha256').update(payload).digest('hex');
  const downloadDir = join(ARTIFACT_DIR, 'downloads');
  mkdirSync(downloadDir, { recursive: true });

  console.log(`\nSingle-file app suite — opened straight from disk, no server, no network`);
  console.log(`  ${PAGE_URL} (${(statSync(SINGLE_FILE).size / 1024).toFixed(0)} kB)\n`);

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
  const networkRequests = [];
  for (const [label, page] of [
    ['A', pageA],
    ['B', pageB],
  ]) {
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(`[${label}] ${message.text().slice(0, 160)}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`[${label}] pageerror: ${error.message.slice(0, 160)}`));
    page.on('request', (request) => {
      const url = request.url();
      if (url.startsWith('data:') || url.startsWith('blob:')) return;
      networkRequests.push(`[${label}] ${url.slice(0, 120)}`);
    });
  }
  const a = appApi(pageA);
  const b = appApi(pageB);
  const { results, check } = checkRunner();
  let inviteCode = '';
  let replyCode = '';

  try {
    await check('the app opens from a local file, with no server to talk to', async () => {
      await Promise.all([
        pageA.goto(`${PAGE_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
        pageB.goto(`${PAGE_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
      ]);
      const environment = await pageA.evaluate(() => ({
        protocol: location.protocol,
        secureContext: window.isSecureContext,
        signalingMode: globalThis.__lanshare?.signalingMode?.() ?? null,
      }));
      assert(environment.protocol === 'file:', `expected file://, saw ${environment.protocol}`);
      assert(environment.secureContext, 'a file:// page is not a secure context in this browser');
      await waitFor(async () => /Nearby devices/i.test(await a.bodyText()), 'the shell to render');
    });

    await check('it says so honestly instead of pretending to connect', async () => {
      const text = await a.bodyText();
      assert(
        /No connection service configured/i.test(text),
        'the app did not report the missing connection service',
      );
      assert(!/Cannot reach the connection service/i.test(text), 'the app tried to connect to a server that cannot exist');
      const [stateA, stateB] = await Promise.all([a.snapshot(), b.snapshot()]);
      for (const state of [stateA, stateB]) {
        assert(state?.signalingState !== 'connected', 'signaling reported connected with no server present');
      }
    });

    await check('the document fetches nothing at all', async () => {
      // Only the local file itself (and the fixture/upload) may appear — no hosts, no CDN.
      const foreign = networkRequests.filter((entry) => !/^\[[AB]\] file:\/\//.test(entry));
      assert(foreign.length === 0, `requests outside the file:// document: ${foreign.slice(0, 5).join(', ')}`);
    });

    await check('the first device produces an invite code', async () => {
      await a.openServerlessPairing();
      assert(await a.clickButton('^Create a pairing code$'), 'the create-pairing-code action was not found');
      inviteCode = await waitForValue(() => a.readCode('Invite pairing code'), 'the invite code');
      assert(inviteCode.startsWith('LS1'), `unexpected invite format: ${inviteCode.slice(0, 12)}…`);
      console.log(`        invite: ${inviteCode.length} characters`);
    });

    await check('the second device accepts it and replies', async () => {
      await b.openServerlessPairing();
      assert(await b.clickButton('I have a code'), 'the "I have a code" action was not found');
      await b.fillCode('Pairing code', inviteCode);
      assert(await b.clickButton('^Create reply code$'), 'the create-reply-code action was not found');
      replyCode = await waitForValue(() => b.readCode('Reply pairing code'), 'the reply code');
      assert(replyCode.startsWith('LS1'), `unexpected reply format: ${replyCode.slice(0, 12)}…`);
    });

    await check('the devices pair with no server involved', async () => {
      await a.fillCode('Reply code', replyCode);
      assert(await a.clickButton('^Connect$'), 'the connect action was not found');
      await waitFor(async () => /Paired with/i.test(await a.bodyText()), 'the paired confirmation', 30_000);
      await Promise.all([
        waitFor(async () => (await a.deviceNames()).length > 0, 'device A to list device B'),
        waitFor(async () => (await b.deviceNames()).length > 0, 'device B to list device A'),
      ]);
      console.log(`        A sees: ${JSON.stringify(await a.deviceNames())}`);
    });

    await check('a data channel opens between the two pages', async () => {
      await waitFor(
        async () => {
          const [stateA, stateB] = await Promise.all([a.snapshot(), b.snapshot()]);
          const live = (state) => Boolean(state?.links?.some((link) => link.ctl === 'open' && link.bin === 'open'));
          return live(stateA) && live(stateB);
        },
        'open ctl/bin channels on both sides',
        30_000,
      );
    });

    const peerNameOnA = (await a.deviceNames())[0];

    await check('a file transfers between the two single-file apps', async () => {
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
          return Boolean(state?.transfers?.some((t) => t.status === 'completed' && t.bytes === 512 * 1024));
        },
        'the receiver to report a completed 512 KiB transfer',
        60_000,
      );
    });

    await check('the received bytes hash to the source file', async () => {
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
          item.textContent?.includes('single-file-payload.bin'),
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

    await check('neither page logged an application error', async () => {
      assert(consoleErrors.length === 0, `console errors: ${consoleErrors.slice(0, 5).join(' | ')}`);
    });
  } finally {
    await browser.close().catch(() => undefined);
  }

  const passed = results.filter((entry) => entry.ok).length;
  const failed = results.filter((entry) => !entry.ok);
  writeFileSync(
    join(ARTIFACT_DIR, 'summary.json'),
    JSON.stringify({ file: SINGLE_FILE, sizeBytes: statSync(SINGLE_FILE).size, checks: results }, null, 2),
  );
  console.log('\n────────────────────────────────────────────────────────────────');
  console.log(`Single-file app result: ${passed}/${results.length} checks passed`);
  if (failed.length) {
    for (const entry of failed) console.log(`  ✗ ${entry.name}: ${entry.error}`);
    console.log(`  artefacts kept for inspection: ${ARTIFACT_DIR}`);
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

await main();
