/**
 * Live probe — verifies the app served by the *dev server* (`npm run start:all`):
 * vite on :5173 proxying /ws to the signaling server on :8080.
 *
 * The e2e suites cover the production build (`vite preview`) and the GitHub-Pages
 * deployment shape; this probe covers the local/preview path, where the app resolves
 * its signaling URL as same-origin `/ws` and must go through the Vite proxy under a
 * non-localhost hostname. Run it while the app is running:
 *
 *   npm run start:all        # terminal 1
 *   npm run probe:live       # terminal 2
 *
 * It drives two real browser tabs (isolated contexts = two devices) and asserts the
 * whole chain: dev-server boot -> signaling open -> discovery -> open ctl/bin data
 * channel -> offer -> receiver approval -> 512 KiB transfer -> the received file
 * hashes to the source. Needs puppeteer (same resolution chain as the e2e harness).
 */

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
  throw new Error(`Puppeteer is required for the live probe.\nInstall it with \`npm i -D puppeteer\` or set PUPPETEER_PATH.\nTried:\n  ${errors.join('\n  ')}`);
}
const puppeteer = loadPuppeteer();
const { createHash, randomBytes } = require('node:crypto');
const { writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const PORT = Number(process.env.PROBE_APP_PORT ?? 5173);
const HOST = process.env.PROBE_HOST ?? 'preview-probe.test'; // not localhost / .local / .github.io -> same-origin /ws branch
const ORIGIN = `http://${HOST}:${PORT}`;
const DIR = '/tmp/live-probe';
const DL = join(DIR, 'downloads');
const FIXTURE = join(DIR, 'live-payload.bin');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function assert(cond, message) {
  if (!cond) throw new Error(message);
}
async function waitFor(fn, message, timeout = 30000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${message}`);
    await sleep(150);
  }
}

function api(page) {
  return {
    bodyText: () => page.evaluate(() => document.body.innerText),
    snapshot: () => page.evaluate(() => globalThis.__lanshare?.snapshot?.() ?? null),
    async deviceNames() {
      return page.evaluate(() => {
        const heading = Array.from(document.querySelectorAll('h2')).find((n) =>
          n.textContent?.includes('Nearby devices'),
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
    async clickText(pattern) {
      return page.evaluate((src) => {
        const re = new RegExp(src);
        const button = Array.from(document.querySelectorAll('button')).find((b) =>
          re.test(b.textContent?.trim() ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      }, pattern);
    },
    async acceptIncoming() {
      await waitFor(
        () => page.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label="Incoming transfer"]'))),
        'the incoming transfer dialog',
        30000,
      );
      const clicked = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"][aria-label="Incoming transfer"]');
        const accept = Array.from(dialog.querySelectorAll('button')).find((b) =>
          /^Accept/.test(b.textContent?.trim() ?? ''),
        );
        if (!accept) return false;
        accept.click();
        return true;
      });
      assert(clicked, 'accept button missing');
    },
  };
}

async function requireRunningApp() {
  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  } catch (error) {
    console.error(`No app on http://127.0.0.1:${PORT}/ (${error.message}).\nStart it first:  npm run start:all`);
    process.exit(2);
  }
}

(async () => {
  await requireRunningApp();
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DL, { recursive: true });
  const payload = randomBytes(512 * 1024);
  writeFileSync(FIXTURE, payload);
  const sourceHash = createHash('sha256').update(payload).digest('hex');
  console.log(`fixture: 512 KiB, sha256 ${sourceHash.slice(0, 16)}…`);

  const browser = await puppeteer.launch({
    headless: true,
    downloadsPath: DL,
    protocolTimeout: 60_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
      `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
    ],
  });

  const consoleErrors = [];
  const contextA = await browser.createBrowserContext();
  const contextB = await browser.createBrowserContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  for (const [label, page] of [['A', pageA], ['B', pageB]]) {
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(`[${label}] ${m.text()}`);
    });
    page.on('pageerror', (e) => consoleErrors.push(`[${label}] pageerror: ${e.message}`));
  }
  const a = api(pageA);
  const b = api(pageB);

  let failures = 0;
  const step = async (label, fn) => {
    const started = Date.now();
    try {
      await fn();
      console.log(`  PASS  ${label} (${Date.now() - started} ms)`);
    } catch (error) {
      failures += 1;
      console.log(`  FAIL  ${label} — ${error.message}`);
      throw error;
    }
  };

  try {
    await step('both tabs boot from the dev server and open signaling', async () => {
      await Promise.all([
        pageA.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' }),
        pageB.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' }),
      ]);
      const served = await pageA.evaluate(() =>
        Array.from(document.querySelectorAll('script[src]')).some((s) => /\/src\/main\.tsx/.test(s.getAttribute('src') ?? '')),
      );
      assert(served, 'the page was not served by the vite dev server (no /src/main.tsx module)');
      await waitFor(async () => {
        const [sa, sb] = await Promise.all([a.snapshot(), b.snapshot()]);
        const live = (state) => ['open', 'connected'].includes(state?.signalingState);
        return live(sa) && live(sb);
      }, 'signaling to open in both tabs');
      await a.clickText('^Continue$').catch(() => {});
      await Promise.all([a.clickText('^Continue$'), b.clickText('^Continue$')]);
    });

    await step('each tab discovers the other', async () => {
      await waitFor(async () => (await a.deviceNames()).length > 0, 'tab A to see tab B');
      await waitFor(async () => (await b.deviceNames()).length > 0, 'tab B to see tab A');
      console.log(`        A sees: ${JSON.stringify(await a.deviceNames())}`);
    });

    await step('a direct WebRTC data channel opens automatically', async () => {
      await waitFor(async () => {
        const state = await a.snapshot();
        return Boolean(
          state?.peers?.some((p) => p.status === 'connected') &&
            state?.links?.some((l) => l.ctl === 'open' && l.bin === 'open'),
        );
      }, 'an open ctl/bin data channel');
    });

    // The sender (A) must pick the peer it sees — that is B's friendly name.
    const nameB = (await a.deviceNames())[0] ?? (await a.snapshot())?.peers?.[0]?.name;
    console.log(`        peer name: ${nameB}`);

    await step('a file is offered and the receiver must approve', async () => {
      const input = await pageA.$('input[type="file"]');
      assert(input, 'file input not found');
      await input.uploadFile(FIXTURE);
      await waitFor(async () => (await a.bodyText()).includes('Selected files'), 'the queue to list the file');
      assert(await a.clickText('^Send \\d+ files?$|^Send file$'), 'send button missing');
      await waitFor(
        () => pageA.evaluate(() => Boolean(document.querySelector('[role="dialog"][aria-label^="Send files to"]'))),
        'the device picker',
      );
      const offered = await pageA.evaluate((name) => {
        const dialog = document.querySelector('[role="dialog"][aria-label^="Send files to"]');
        const button = Array.from(dialog.querySelectorAll('button')).find(
          (candidate) => candidate.textContent?.includes('Send') && candidate.closest('li')?.textContent?.includes(name),
        );
        if (!button) return false;
        button.click();
        return true;
      }, nameB);
      assert(offered, `send target for ${nameB} missing`);
      await b.acceptIncoming();
    });

    await step('the transfer completes on both sides with the full byte count', async () => {
      await waitFor(async () => {
        const state = await b.snapshot();
        return state?.transfers?.some((t) => t.status === 'completed' && t.bytes === 512 * 1024);
      }, 'the receiver to report a completed 512 KiB transfer', 45000);
      await waitFor(
        async () => /Received from/.test(await b.bodyText()) && /Completed/.test(await b.bodyText()),
        'the receiver row to show Received from + Completed',
        30000,
      );
      await waitFor(
        async () => /Sent to/.test(await a.bodyText()) && /Completed/.test(await a.bodyText()),
        'the sender row to show Sent to + Completed',
        30000,
      );
      const [sa, sb] = await Promise.all([a.snapshot(), b.snapshot()]);
      console.log(`        A: ${JSON.stringify(sa.transfers)}`);
      console.log(`        B: ${JSON.stringify(sb.transfers)}`);
    });

    await step('the received bytes hash to the source file', async () => {
      const browserSession = await pageB.browser().target().createCDPSession();
      const pageSession = await pageB.createCDPSession();
      const { targetInfo } = await pageSession.send('Target.getTargetInfo');
      await browserSession.send('Browser.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: DL,
        eventsEnabled: true,
        ...(targetInfo.browserContextId ? { browserContextId: targetInfo.browserContextId } : {}),
      });
      const before = new Set(readdirSync(DL));
      const clicked = await pageB.evaluate(() => {
        const row = Array.from(document.querySelectorAll('li')).find((item) =>
          item.textContent?.includes('live-payload.bin'),
        );
        const button = Array.from(row?.querySelectorAll('button') ?? []).find((candidate) =>
          /Download/.test(candidate.getAttribute('aria-label') ?? ''),
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(clicked, 'download button missing on the received file');
      const landed = await waitFor(async () => {
        const added = readdirSync(DL).filter((n) => !before.has(n) && !n.endsWith('.crdownload'));
        if (added.length === 0) return null;
        const path = join(DL, added[0]);
        let previous = -1;
        for (let i = 0; i < 60; i += 1) {
          const size = existsSync(path) ? readFileSync(path).length : 0;
          if (size > 0 && size === previous) return path;
          previous = size;
          await sleep(100);
        }
        return null;
      }, 'the download to land', 30000);
      const receivedHash = createHash('sha256').update(readFileSync(landed)).digest('hex');
      assert(receivedHash === sourceHash, `hash mismatch: ${receivedHash.slice(0, 16)}… vs ${sourceHash.slice(0, 16)}…`);
      console.log(`        received ${readFileSync(landed).length} bytes, sha256 ${receivedHash.slice(0, 16)}… — identical`);
      await pageSession.detach().catch(() => {});
      await browserSession.detach().catch(() => {});
    });

    await step('no console errors in either tab', async () => {
      assert(consoleErrors.length === 0, `console errors: ${JSON.stringify(consoleErrors.slice(0, 5))}`);
    });
  } catch {
    /* the failing step is already reported */
  } finally {
    await browser.close().catch(() => {});
    rmSync(join(DIR, 'downloads'), { recursive: true, force: true });
  }

  console.log(
    failures === 0
      ? '\nLIVE RESULT: PASS — the running dev server + signaling server performed a real P2P transfer'
      : `\nLIVE RESULT: FAIL (${failures} step(s))`,
  );
  process.exit(failures === 0 ? 0 : 1);
})();
