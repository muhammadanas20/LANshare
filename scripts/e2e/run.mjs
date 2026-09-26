/**
 * LANShare end-to-end test.
 *
 * Exercises the real production build in real browsers:
 *   built frontend  ->  vite preview (same-origin /ws proxy)  ->  signaling server
 *                    ->  two isolated browser contexts  ->  WebRTC data channel
 *
 * It verifies discovery, consent, chunked transfer, byte-level integrity (SHA-256 of
 * a downloaded file), multi-file ZIP download, text sharing, cancellation and refusal.
 *
 * Requirements: `npm run build` and `npm --prefix server run build` must have run, and
 * puppeteer must be installed (dev dependency or PUPPETEER_PATH).
 *
 * Usage: node scripts/e2e/run.mjs
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8099);
const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4183);
const BASE_URL = `http://localhost:${PREVIEW_PORT}/`;
const ORIGIN = `http://localhost:${PREVIEW_PORT}`;

// Keep the browser download in the user's cache directory (never inside the repo).
process.env.PUPPETEER_CACHE_DIR ??= join(homedir(), '.cache', 'puppeteer');

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
  throw new Error(
    `Puppeteer is required for the browser end-to-end test.\nInstall it with \`npm i -D puppeteer\` or set PUPPETEER_PATH.\nTried:\n  ${errors.join('\n  ')}`,
  );
}

/* ------------------------------- helpers ------------------------------- */

const results = [];
let failures = 0;

let diagnostics = null;

async function dumpDiagnostics() {
  if (!diagnostics) return;
  const pages = [
    ['A', diagnostics.pageA],
    ['B', diagnostics.pageB],
  ];
  for (const [label, page] of pages) {
    if (page.isClosed()) continue;
    const body = await page
      .evaluate(() => document.body.innerText)
      .catch((error) => `<unavailable: ${error.message}>`);
    console.error(`\n  ── page ${label} ──\n${body.split('\n').slice(0, 30).map((line) => `     ${line}`).join('\n')}`);
    const snapshot = await page
      .evaluate(() => {
        const state = globalThis.__lanshare?.snapshot?.();
        if (!state) return '<no snapshot>';
        return JSON.stringify({
          peers: state.peers.map((peer) => ({ name: peer.name, status: peer.status, link: peer.link })),
          transfers: state.transfers.map((transfer) => ({
            direction: transfer.direction,
            status: transfer.status,
            bytes: transfer.bytes,
            total: transfer.total,
            error: transfer.error,
          })),
          links: state.links,
        });
      })
      .catch((error) => `<unavailable: ${error.message}>`);
    console.error(`     state: ${snapshot}`);
  }
  if (diagnostics.consoleErrors.length) {
    console.error(`\n  ── console errors ──\n${diagnostics.consoleErrors.slice(0, 8).map((line) => `     ${line}`).join('\n')}`);
  }
  await dumpSignalingState();
}

async function dumpSignalingState() {
  try {
    const response = await fetch(`http://127.0.0.1:${SIGNALING_PORT}/health`);
    console.error(`\n  ── signaling health ──\n     ${await response.text()}`);
  } catch (error) {
    console.error(`\n  ── signaling health ──\n     unreachable: ${error.message}`);
  }
}

async function check(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
  } catch (error) {
    failures += 1;
    results.push({ name, ok: false, ms: Date.now() - started, error: error.message });
    console.error(`  ✗ ${name} (${Date.now() - started} ms)\n      ${error.message}`);
    await dumpDiagnostics();
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitFor(fn, { timeout = 20000, interval = 100, message = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    if (await fn()) return true;
    if (Date.now() - started > timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Poll until `fn` returns a truthy value, then return that value. */
async function waitForValue(fn, message, timeout = 20000) {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

async function waitForHttp(url, timeout = 30000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.status < 500) return true;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeout) throw new Error(`Service did not come up: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/* --------------------------- deterministic files --------------------------- */

const ARTIFACT_DIR = mkdtempSync(join(tmpdir(), 'lanshare-e2e-'));
// A failing run keeps its artefacts for inspection, so prune the ones older runs left behind:
// the container's /tmp is a small tmpfs (≈1 GB) and stale dumps have already caused renderer
// crashes once. Existing dirs from the *current* run are untouched.
try {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith('lanshare-e2e-')) continue;
    const path = join(tmpdir(), entry);
    if (path === ARTIFACT_DIR) continue;
    rmSync(path, { recursive: true, force: true });
  }
} catch {
  /* nothing to prune */
}

/**
 * Chromium initialises its default download folder (`~/Downloads`) on launch even when a
 * different `downloadsPath` is configured. Remember whether it existed so a run inside a
 * throwaway home directory (CI, containers) does not leave the folder behind.
 */
const DEFAULT_DOWNLOADS_DIR = join(homedir(), 'Downloads');
const defaultDownloadsExisted = existsSync(DEFAULT_DOWNLOADS_DIR);
function cleanupDefaultDownloadsDir() {
  if (defaultDownloadsExisted) return;
  try {
    // Only ever removes an *empty* directory that this run created.
    rmdirSync(DEFAULT_DOWNLOADS_DIR);
  } catch {
    /* not empty or already gone — leave it alone */
  }
}
/** Remove every generated artefact (the container /tmp is a small tmpfs). */
function cleanupArtifacts() {
  try {
    rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  cleanupDefaultDownloadsDir();
}

/** 3 MB PNG-typed payload with a byte pattern (spans many 64 KiB chunks). */
function buildBinaryArtifact() {
  const bytes = new Uint8Array(3 * 1024 * 1024);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = (index * 31 + (index >> 8)) % 256;
  const path = join(ARTIFACT_DIR, 'pattern.png');
  writeFileSync(path, bytes);
  return { path, name: 'pattern.png', mime: 'image/png', size: bytes.length, sha256: sha256(Buffer.from(bytes)) };
}

/** ~180 KB of text so the receiver's inline preview can be compared byte-for-byte. */
function buildTextArtifact() {
  const lines = [];
  for (let index = 0; index < 3000; index += 1) {
    lines.push(`${String(index).padStart(5, '0')} :: LANShare chunk integrity line :: ${(index * 7919) % 104729}`);
  }
  const text = lines.join('\n');
  const path = join(ARTIFACT_DIR, 'notes.txt');
  writeFileSync(path, text, 'utf8');
  return { path, name: 'notes.txt', mime: 'text/plain', size: Buffer.byteLength(text), text };
}

function buildSmallArtifact(name, contents) {
  const path = join(ARTIFACT_DIR, name);
  writeFileSync(path, contents);
  return { path, name };
}

/** One-line summary of an in-page progress sample log, used in failure messages. */
function progressDigest(log) {
  const averageGap = log.gaps.length ? Math.round(log.gaps.reduce((sum, gap) => sum + gap, 0) / log.gaps.length) : 0;
  return (
    `samples=${log.sampled} gaps≈${averageGap}ms withPercent=${log.samplesWithPercent} percent=${log.percent.length} ` +
    `speed=${log.speed.length} eta=${log.eta.length} source=${log.percentageSource} seen="${log.contexts[0] ?? ''}"`
  );
}

/** Absolute path to the axe-core bundle, or null when dev dependencies are missing. */
function axeCorePath() {
  try {
    return createRequire(import.meta.url).resolve('axe-core/axe.min.js');
  } catch {
    return null;
  }
}

/**
 * Run an axe-core accessibility audit on the current page state.
 * Returns a compact list so failures name the rule, the impact and a representative node.
 */
async function auditAccessibility(page, label) {
  const path = axeCorePath();
  if (!path) return { label, violations: [], unavailable: true };
  await page.addScriptTag({ path });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { resultTypes: ['violations'] });
    return result.violations.map((violation) => {
      const node = violation.nodes[0];
      const data = node?.any?.[0]?.data ?? node?.all?.[0]?.data ?? null;
      return {
        id: violation.id,
        impact: violation.impact ?? 'unknown',
        help: violation.help,
        count: violation.nodes.length,
        target: node?.target?.join(' ') ?? '',
        html: (node?.html ?? '').slice(0, 70),
        // colour-contrast reports the measured values: keep them, they name the culprit.
        contrast: data && data.contrastRatio
          ? `ratio ${data.contrastRatio} (needs ${data.expectedContrastRatio}), fg ${data.fgColor}, bg ${data.bgColor}, ${data.fontSize} ${data.fontWeight}`
          : null,
        theme: document.documentElement.dataset.theme ?? 'light',
      };
    });
  });
  return { label, violations };
}

/* ------------------------------- page API ------------------------------- */

/** Thin, readable wrapper around the app's real UI. */
function appApi(page) {
  const text = async (selector) => page.$eval(selector, (el) => el.textContent ?? '').catch(() => null);
  const visible = async (selector) => page.$(selector).then(Boolean);

  return {
    page,
    async waitForApp() {
      await page.waitForSelector('text/Share anything nearby', { timeout: 30000 });
    },
    async waitForSignaling() {
      // The header chip switches to "Ready to receive"/"N connected" once WELCOME lands.
      await waitFor(
        async () => {
          const body = await page.evaluate(() => document.body.innerText);
          return /Ready to receive|\d+ connected/.test(body);
        },
        { message: 'the signaling connection to become ready' },
      );
    },
    async openDevices() {
      // Rendering the device list happens automatically; nothing to click.
      await page.waitForSelector('h2 ::-p-text(Nearby devices)', { timeout: 15000 }).catch(async () => {
        await page.waitForSelector('text/Nearby devices', { timeout: 15000 });
      });
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
            // The device-name span carries a `title` attribute equal to the peer name.
            const named = item.querySelector('button span[title]');
            if (named) return named.getAttribute('title') ?? '';
            const text = item.querySelector('button')?.textContent?.trim() ?? '';
            return text.replace(/[✓◌·].*$/, '').trim();
          })
          .filter(Boolean);
      });
    },

    /** Close any open dialog so a check starts from a clean slate. */
    async dismissDialogs() {
      for (let index = 0; index < 5; index += 1) {
        const count = await page.evaluate(() => document.querySelectorAll('[role="dialog"]').length);
        if (count === 0) return;
        await page.keyboard.press('Escape');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const remaining = await page.evaluate(() =>
        Array.from(document.querySelectorAll('[role="dialog"]')).map((dialog) => dialog.getAttribute('aria-label')),
      );
      if (remaining.length > 0) throw new Error(`Dialogs would not close: ${remaining.join(', ')}`);
    },
    async waitForPeer(timeout = 25000) {
      await waitFor(async () => (await this.deviceNames()).length > 0, {
        timeout,
        message: 'the other device to appear in the nearby list',
      });
      return (await this.deviceNames())[0];
    },
    /**
     * Wait for a *usable* link: the surviving peer must be `connected` **and** its `ctl`/`bin`
     * data channels open. UI text alone cannot tell a live channel from a dead one.
     */
    async waitForDataChannel(timeout = 30000) {
      await waitFor(
        async () => {
          const state = await this.snapshot();
          return Boolean(
            state &&
              state.peers.some((peer) => peer.status === 'connected') &&
              state.links.some((link) => link.ctl === 'open' && link.bin === 'open'),
          );
        },
        { timeout, message: 'an open ctl/bin data channel to the other device' },
      );
    },
    async waitForConnectedPeer(timeout = 30000) {
      await waitFor(
        async () => {
          const body = await page.evaluate(() => document.body.innerText);
          return body.includes('✓ Connected') || /Connected\b/.test(body);
        },
        { timeout, message: 'a direct WebRTC connection' },
      );
    },
    async addFiles(paths) {
      const input = await page.$('input[type="file"]');
      assert(input, 'file input not found');
      await input.uploadFile(...paths);
    },
    async queueSummary() {
      return text('#file-queue-heading');
    },
    async waitForQueued(count) {
      await waitFor(
        async () => {
          const body = await page.evaluate(() => document.body.innerText);
          return body.includes(`${count} file`) && body.includes('Selected files');
        },
        { message: `${count} file(s) to appear in the queue` },
      );
    },
    async clickSendForQueue() {
      const clicked = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const target = buttons.find((button) => /^Send \d+ files?$|^Send file$/.test(button.textContent?.trim() ?? ''));
        if (!target) return false;
        target.click();
        return true;
      });
      assert(clicked, 'send button missing');
      await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
    },
    async dialogByTitle(title) {
      return page.evaluate((wanted) => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (candidate) => candidate.getAttribute('aria-label') === wanted,
        );
        return dialog ? dialog.textContent ?? '' : null;
      }, title);
    },
    async waitForDialog(title, timeout = 20000) {
      await waitFor(async () => (await this.dialogByTitle(title)) !== null, {
        timeout,
        message: `the “${title}” dialog`,
      });
    },
    async chooseDeviceInDialog(name) {
      await waitFor(
        async () => {
          const text = await page.evaluate(() => {
            const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((candidate) =>
              /^Send (files|text) to/.test(candidate.getAttribute('aria-label') ?? ''),
            );
            return dialog?.textContent ?? null;
          });
          return Boolean(text && text.includes(name));
        },
        { message: `the send dialog to offer ${name}` },
      );
      const clicked = await page.evaluate((needle) => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find((candidate) =>
          /^Send (files|text) to/.test(candidate.getAttribute('aria-label') ?? ''),
        );
        const buttons = Array.from(dialog?.querySelectorAll('button') ?? []);
        const target = buttons.find(
          (button) => button.textContent?.includes('Send') && button.closest('li')?.textContent?.includes(needle),
        );
        if (!target) return false;
        target.click();
        return true;
      }, name);
      assert(clicked, `send target button for ${name} missing`);
    },
    async acceptIncoming() {
      await this.waitForDialog('Incoming transfer', 25000);
      const clicked = await page.evaluate(() => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (candidate) => candidate.getAttribute('aria-label') === 'Incoming transfer',
        );
        const buttons = Array.from(dialog?.querySelectorAll('button') ?? []);
        const accept = buttons.find((button) => /^Accept/.test(button.textContent?.trim() ?? ''));
        if (!accept) return false;
        accept.click();
        return true;
      });
      assert(clicked, 'accept button missing');
    },
    async declineIncoming() {
      await this.waitForDialog('Incoming transfer', 25000);
      const clicked = await page.evaluate(() => {
        const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(
          (candidate) => candidate.getAttribute('aria-label') === 'Incoming transfer',
        );
        const buttons = Array.from(dialog?.querySelectorAll('button') ?? []);
        const decline = buttons.find((button) => /^Decline$/.test(button.textContent?.trim() ?? ''));
        if (!decline) return false;
        decline.click();
        return true;
      });
      assert(clicked, 'decline button missing');
    },
    async bodyText() {
      return page.evaluate(() => document.body.innerText);
    },
    /**
     * Sample the DOM from inside the page so short-lived progress renders cannot be
     * missed by the harness polling interval.
     */
    async startProgressRecorder() {
      await page.evaluate(() => {
        // `gaps` and `samplesWithPercent` exist so a missed render can be told apart from a
        // throttled sampler: if the gaps are ~50 ms the timer really did tick.
        const log = {
          speed: [],
          eta: [],
          percent: [],
          sampled: 0,
          gaps: [],
          samplesWithPercent: 0,
          contexts: [],
          percentageSource: 'none',
        };
        window.__progressLog = log;
        let previous = performance.now();
        const scan = () => {
          const now = performance.now();
          log.sampled += 1;
          if (log.gaps.length < 60) log.gaps.push(Math.round(now - previous));
          previous = now;
          const text = document.body.innerText;
          const speed = text.match(/\d+(?:\.\d+)? (?:KB|MB|GB)\/s/);
          if (speed) log.speed.push(speed[0]);
          const eta = text.match(/ETA: [^\n]+/);
          if (eta) log.eta.push(eta[0]);
          const percentages = [...text.matchAll(/(\d{1,3})%/g)];
          for (const match of percentages) log.percent.push(Number(match[1]));
          if (percentages.length > 0) {
            log.samplesWithPercent += 1;
            if (log.contexts.length < 5) {
              const at = text.indexOf('%');
              log.contexts.push(text.slice(Math.max(0, at - 40), at + 3).replace(/\s+/g, ' '));
            }
          }
          if (percentages.length === 0 && /\d\s*%/.test(text)) log.percentageSource = 'digit-space-percent';
          else if (percentages.length > 0) log.percentageSource = 'digit-percent';
        };
        if (window.__progressTimer) clearInterval(window.__progressTimer);
        window.__progressTimer = setInterval(scan, 50);
        scan();
      });
    },
    /** Read the live sample log without stopping the recorder (used mid-suite). */
    async peekProgressLog() {
      return page.evaluate(
        () =>
          window.__progressLog ?? {
            speed: [],
            eta: [],
            percent: [],
            sampled: 0,
            gaps: [],
            samplesWithPercent: 0,
            contexts: [],
            percentageSource: 'none',
          },
      );
    },
    async progressLog() {
      return page.evaluate(() => {
        if (window.__progressTimer) clearInterval(window.__progressTimer);
        return window.__progressLog ?? { speed: [], eta: [], percent: [], sampled: 0 };
      });
    },
    async kindText() {
      return page.evaluate(() => document.body.innerText);
    },
    /** Read-only debug snapshot (`?debug=1`): signalling state, peers and link internals. */
    async snapshot() {
      return page
        .evaluate(() => {
          const state = globalThis.__lanshare?.snapshot?.();
          if (!state) return null;
          return {
            selfId: state.selfId,
            roomId: state.roomId,
            signalingState: state.signalingState,
            peers: state.peers.map((peer) => ({ id: peer.id, name: peer.name, status: peer.status, link: peer.link })),
            links: (state.links ?? []).map((link) => ({
              peerId: link.peerId,
              initiator: link.initiator,
              status: link.status,
              ctl: link.ctl,
              bin: link.bin,
              // Identity learnt from the peer's in-band HELLO message (WebRTC path).
              identity: link.identity?.name ?? null,
            })),
          };
        })
        .catch(() => null);
    },
    async waitForBodyText(needle, timeout = 30000) {
      await waitFor(
        async () => {
          const body = await page.evaluate(() => document.body.innerText);
          return body.includes(needle);
        },
        { timeout, message: `“${needle}” to appear on screen` },
      );
    },
    async progressPercent(timeout = 30000) {
      await waitFor(
        async () => {
          const body = await page.evaluate(() => document.body.innerText);
          return /\d+%/.test(body);
        },
        { timeout, message: 'transfer progress' },
      );
      const body = await page.evaluate(() => document.body.innerText);
      const matches = body.match(/(\d+)%/g) ?? [];
      return Number((matches.at(-1) ?? '0%').replace('%', ''));
    },
    /** Click an icon-only button by `aria-label` (falls back to prefix matching). */
    /** Wait until a received-file row for `name` exists with its own download button. */
    async waitForReceivedFile(name, timeout = 60000) {
      await waitFor(
        async () =>
          page.evaluate((wanted) => {
            const rows = Array.from(document.querySelectorAll('li'));
            return rows.some((row) => {
              if (!row.textContent?.includes(wanted)) return false;
              return Array.from(row.querySelectorAll('button[aria-label]')).some((button) =>
                (button.getAttribute('aria-label') ?? '').startsWith('Download '),
              );
            });
          }, name),
        { timeout, message: `a received file row for ${name}` },
      );
    },
    async clickAriaButton(label) {
      const clicked = await page.evaluate((wanted) => {
        const buttons = Array.from(document.querySelectorAll('button[aria-label]')).filter((button) => {
          if (button.disabled) return false;
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0;
        });
        const target =
          buttons.find((button) => button.getAttribute('aria-label') === wanted) ??
          buttons.find((button) => (button.getAttribute('aria-label') ?? '').startsWith(wanted));
        if (!target) return false;
        target.click();
        return true;
      }, label);
      assert(clicked, `button labelled "${label}" not found`);
    },
    async clickButton(pattern) {
      const clicked = await page.evaluate((source) => {
        const regex = new RegExp(source, 'i');
        const buttons = Array.from(document.querySelectorAll('button')).filter((button) => {
          if (button.disabled) return false;
          const rect = button.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && getComputedStyle(button).visibility !== 'hidden';
        });
        const target = buttons.find((button) => regex.test(button.textContent?.trim() ?? ''));
        if (!target) return false;
        target.click();
        return true;
      }, pattern);
      assert(clicked, `button matching ${pattern} not found`);
    }
  };
}

/**
 * Allow downloads into `directory` for the page's *browser context*.
 * `Browser.setDownloadBehavior` without `browserContextId` only affects the default
 * context, and this test uses isolated contexts — so downloads were silently blocked.
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

async function waitForDownload(directory, before, timeout = 30000) {
  const started = Date.now();
  for (;;) {
    const current = new Set(readdirSync(directory));
    const added = [...current].filter((name) => !before.has(name) && !name.endsWith('.crdownload'));
    if (added.length > 0) {
      const path = join(directory, added[0]);
      // Wait for the file to stop growing.
      let lastSize = -1;
      for (let index = 0; index < 60; index += 1) {
        const size = existsSync(path) ? readFileSync(path).length : 0;
        if (size > 0 && size === lastSize) return path;
        lastSize = size;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return path;
    }
    if (Date.now() - started > timeout) throw new Error('Timed out waiting for a browser download');
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/* --------------------------------- main --------------------------------- */

async function main() {
  console.log('\nLANShare end-to-end test');
  console.log('───────────────────────');

  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html is missing — run `npm run build` first.');
  }
  if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) {
    throw new Error('server/dist/index.js is missing — run `npm --prefix server run build` first.');
  }

  const puppeteer = loadPuppeteer();
  const downloadDir = join(ARTIFACT_DIR, 'downloads');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(downloadDir, { recursive: true });

  const children = [];
  const cleanup = () => {
    for (const child of children) {
      try {
        // `npx vite preview` spawns vite as a grandchild, which outlives a plain
        // `child.kill()`. Every child is started detached (its own process group) so the
        // whole tree goes away and the port is free for the next run.
        if (child.pid && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  };
  process.on('exit', cleanup);

  /* 1. signaling server */
  const signaling = spawn('node', [join(ROOT, 'server', 'dist', 'index.js')], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PORT: String(SIGNALING_PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
      MAX_ROOMS: '50',
      ROOM_TTL_MS: String(10 * 60 * 1000),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(signaling);
  signaling.stdout.on('data', (chunk) => process.env.E2E_VERBOSE && process.stdout.write(`  [signal] ${chunk}`));
  signaling.stderr.on('data', (chunk) => process.env.E2E_VERBOSE && process.stderr.write(`  [signal] ${chunk}`));

  /* 2. built frontend + /ws proxy */
  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1'], {
    detached: process.platform !== 'win32',
    cwd: ROOT,
    env: { ...process.env, SIGNALING_PROXY_TARGET: `http://127.0.0.1:${SIGNALING_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(preview);
  preview.stdout.on('data', (chunk) => process.env.E2E_VERBOSE && process.stdout.write(`  [preview] ${chunk}`));

  await waitForHttp(`http://127.0.0.1:${SIGNALING_PORT}/health`);
  await waitForHttp(BASE_URL);
  console.log(`  signaling: http://127.0.0.1:${SIGNALING_PORT}   frontend: ${BASE_URL}`);

  const browser = await puppeteer.launch({
    headless: true,
    // Keep every browser-side download inside the throwaway artefact directory: without
    // this, Chrome initialises (and leaves behind) the default `~/Downloads` folder.
    downloadsPath: downloadDir,
    // A page that stops responding should fail the current check quickly instead of
    // hanging the whole suite for the default 180 s protocol timeout.
    protocolTimeout: 45_000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      `--unsafely-treat-insecure-origin-as-secure=${ORIGIN}`,
      // Precise heap numbers (performance.memory) plus window.gc() for the streaming check.
      '--enable-precise-memory-info',
      '--js-flags=--expose-gc',
    ],
  });

  // Two isolated browser contexts = two independent devices (separate storage, no shared device key).
  const contextA = await browser.createBrowserContext();
  const contextB = await browser.createBrowserContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const consoleErrors = [];
  for (const [label, page] of [
    ['A', pageA],
    ['B', pageB],
  ]) {
    await page.setViewport({ width: 1280, height: 900 });
    page.on('console', (message) => {
      const text = message.text();
      if (process.env.E2E_VERBOSE) console.log(`  [${label}:${message.type()}] ${text}`);
      if (message.type() === 'error') consoleErrors.push(`[${label}] ${text}`);
    });
    page.on('pageerror', (error) => consoleErrors.push(`[${label}] pageerror: ${error.message}`));
    page.on('error', (error) => consoleErrors.push(`[${label}] crashed: ${error.message}`));
  }

  const a = appApi(pageA);
  const b = appApi(pageB);
  diagnostics = { pageA, pageB, consoleErrors };

  try {
    /* ------------------------- boot + discovery ------------------------- */
    console.log('\nDiscovery');
    await check('both clients boot and connect to the signaling server', async () => {
      const debugUrl = `${BASE_URL}?debug=1`;
      await Promise.all([
        pageA.goto(debugUrl, { waitUntil: 'domcontentloaded' }),
        pageB.goto(debugUrl, { waitUntil: 'domcontentloaded' }),
      ]);
      await Promise.all([a.waitForApp(), b.waitForApp()]);
      await Promise.all([a.waitForSignaling(), b.waitForSignaling()]);
    });

    await check('the welcome dialog appears only on the first visit', async () => {
      await waitFor(async () => (await a.bodyText()).includes('Welcome to LANShare'), { message: 'the onboarding dialog' });
      await a.clickButton('^Continue$');
      await a.waitForBodyText('Share anything nearby');
      assert(!(await a.bodyText()).includes('Welcome to LANShare'), 'onboarding should not reappear');
    });

    const nameA = await a.waitForPeer();
    await b.waitForPeer();
    await check('each device discovers the other', async () => {
      assert(nameA && nameA.length > 0, 'device A saw no peers');
      const names = await a.deviceNames();
      assert(names.length >= 1, `expected at least one device, saw ${names.length}`);
    });

    await check('a direct WebRTC data channel is established automatically', async () => {
      await Promise.all([a.waitForConnectedPeer(), b.waitForConnectedPeer()]);
      const state = await pageA.evaluate(async () => {
        // Inspect the real transport, not the UI: a peer connection must be live.
        const connections = performance.getEntriesByType('resource').length >= 0;
        return { ok: connections };
      });
      assert(state.ok, 'unexpected transport state');
    });

    // Each side names the other with its own auto-generated name; a transfer started
    // from A must therefore target the peer label A sees.
    const peerNameForA = (await a.deviceNames())[0] ?? '';
    const peerNameForB = (await b.deviceNames())[0] ?? '';
    assert(peerNameForA && peerNameForB, `device names not detected (A sees "${peerNameForA}", B sees "${peerNameForB}")`);

    /* ----------------------------- file transfer ----------------------------- */
    console.log('\nFile transfer');
    const binary = buildBinaryArtifact();
    const textFile = buildTextArtifact();

    await check('files can be added to the queue with local previews and metadata', async () => {
      await a.addFiles([binary.path, textFile.path]);
      await a.waitForQueued(2);
      const body = await a.bodyText();
      assert(body.includes(binary.name), 'binary file missing from the queue');
      assert(body.includes(textFile.name), 'text file missing from the queue');
      assert(/3\.00 MB|3 MB/.test(body), 'file size not displayed');
      assert(body.includes('PNG image') || body.includes('Text'), 'file type label not displayed');
    });

    const receiverDownloadBefore = new Set(readdirSync(downloadDir));

    await check('receiver must approve before any data flows', async () => {
      // Sample the DOM from inside both pages so a fast transfer cannot hide its
      // progress renders from the next check.
      await Promise.all([a.startProgressRecorder(), b.startProgressRecorder()]);
      await a.clickSendForQueue();
      await a.chooseDeviceInDialog(peerNameForA);
      await b.waitForDialog('Incoming transfer');
      const body = await b.bodyText();
      assert(body.includes(binary.name), 'incoming dialog should list the file names');
      assert(/Accept/.test(body), 'accept action missing');
      // Nothing has been written yet.
      assert(readdirSync(downloadDir).length === receiverDownloadBefore.size, 'downloads started before consent');
      await b.acceptIncoming();
    });

    await check('both sides report live progress, speed and ETA', async () => {
      await Promise.all([a.waitForBodyText('Sending to'), b.waitForBodyText('Receiving from')]);
      // Give both rows a short, bounded moment to paint live progress before the sample
      // logs are read. A transfer that finishes inside one paint simply falls through to
      // the metered-rate assertions below (it cannot hide a *missing* readout: one of the
      // two forms is required), and the strict live-sample check runs on the 20 MB
      // transfer, where the active window lasts for seconds.
      await Promise.all([
        a.waitForBodyText('%', 3000).catch(() => undefined),
        b.waitForBodyText('%', 3000).catch(() => undefined),
      ]);
      // The sample log below is captured inside the page, so even a sub-second
      // transfer cannot hide a progress render from this check.
      await b.waitForReceivedFile(binary.name, 30000).catch(() => undefined);
      const [senderLog, receiverLog] = await Promise.all([a.peekProgressLog(), b.peekProgressLog()]);
      const [senderBody, receiverBody] = await Promise.all([a.bodyText(), b.bodyText()]);
      // The suite's first transfer is only ~3 MB, which loopback can push through inside a
      // single paint — so a live percentage is not *guaranteed* on either side. The
      // requirement here is that each side shows live progress or the metered rate that
      // replaced it; the strict live-sample assertion runs on the 20 MB transfer below,
      // where the active window lasts for seconds. A transfer with neither would still be
      // fake/stalled progress and fails.
      assert(
        senderLog.percent.length > 0 || senderLog.speed.length > 0 || /MB\/s|KB\/s/.test(senderBody),
        `the sender showed no live progress and no metered rate (${progressDigest(senderLog)})`,
      );
      assert(
        receiverLog.percent.length > 0 ||
          receiverLog.speed.length > 0 ||
          receiverLog.eta.length > 0 ||
          /MB\/s|KB\/s/.test(receiverBody),
        `the receiver showed no live progress and no metered rate (${progressDigest(receiverLog)})`,
      );
      assert(/Completed/.test(senderBody) && /Received from/.test(receiverBody), 'transfer summary missing');
    });

    await check('transfer completes on both sides', async () => {
      await Promise.all([
        a.waitForBodyText('Sent to', 60000),
        b.waitForBodyText('Received from', 60000),
      ]);
      await Promise.all([a.waitForBodyText('Completed', 60000), b.waitForBodyText('Completed', 60000)]);
      await b.waitForBodyText('Download all (ZIP)', 30000);
      const body = await b.bodyText();
      assert(/2 files/.test(body), 'receiver did not list the two received files');
    });

    await check('received file integrity — downloaded bytes hash matches the source', async () => {
      // Each received row has its own icon-only download button.
      const binaryDownload = await withDownloadCapture(pageB, downloadDir, async () => {
        const before = new Set(readdirSync(downloadDir));
        await b.clickAriaButton(`Download ${binary.name}`);
        return waitForDownload(downloadDir, before);
      });
      assert(
        sha256(readFileSync(binaryDownload)) === binary.sha256,
        `SHA-256 mismatch for ${binary.name}`,
      );

      const textDownload = await withDownloadCapture(pageB, downloadDir, async () => {
        const before = new Set(readdirSync(downloadDir));
        await b.clickAriaButton(`Download ${textFile.name}`);
        return waitForDownload(downloadDir, before);
      });
      assert(
        readFileSync(textDownload).toString('utf8') === textFile.text,
        'received text file differs from the source',
      );
    });

    await check('multi-file download produces a valid ZIP containing both files', async () => {
      const zipPath = await withDownloadCapture(pageB, downloadDir, async () => {
        const before = new Set(readdirSync(downloadDir));
        await b.clickButton('Download all \\(ZIP\\)');
        return waitForDownload(downloadDir, before);
      });
      const entries = unzipSync(new Uint8Array(readFileSync(zipPath)));
      const names = Object.keys(entries);
      assert(names.includes(binary.name), `ZIP is missing ${binary.name} (has ${names.join(', ')})`);
      assert(names.includes(textFile.name), `ZIP is missing ${textFile.name}`);
      const zippedBinary = entries[binary.name];
      assert(zippedBinary && sha256(Buffer.from(zippedBinary)) === binary.sha256, 'ZIP payload differs from the source file');
      const zippedText = entries[textFile.name];
      assert(zippedText && Buffer.from(zippedText).toString('utf8') === textFile.text, 'ZIP text payload differs');
    });

    /* -------------------------------- text -------------------------------- */
    console.log('\nText sharing');
    await check('text and links can be shared', async () => {
      await a.dismissDialogs();
      await b.dismissDialogs();
      const tabClicked = await pageA.evaluate(() => {
        const tab = document.querySelector('[role="tab"][data-tab="text"]');
        if (!tab) return false;
        tab.click();
        return true;
      });
      assert(tabClicked, 'text tab missing');
      const payload = 'LANShare E2E note\nhttps://example.com/lanshare?ok=1\nEnd of note.';
      await pageA.type('#text-share-input', payload);
      await a.waitForBodyText('Link detected');
      await a.clickButton('^Send text$');
      await a.chooseDeviceInDialog(peerNameForA);
      await b.waitForDialog('Incoming transfer');
      await b.acceptIncoming();
      await Promise.all([a.waitForBodyText('Sent to'), b.waitForBodyText('Received from')]);
      await b.waitForBodyText('Completed');
      await b.clickButton('Show text');
      await b.waitForBodyText('End of note.');
      const body = await b.bodyText();
      assert(body.includes('example.com'), 'received text missing the link');
      assert(!body.includes('javascript:'), 'unexpected scheme rendered');
    });

    /* ------------------------- rejection / cancel ------------------------- */
    console.log('\nConsent and cancellation');

    await check('a declined transfer notifies the sender and transfers nothing', async () => {
      await a.dismissDialogs();
      await b.dismissDialogs();
      const declineFile = buildSmallArtifact('declined-me.txt', 'This should never be written anywhere.');
      await a.addFiles([declineFile.path]);
      await a.waitForQueued(1);
      await a.clickSendForQueue();
      await a.chooseDeviceInDialog(peerNameForA);
      await b.waitForDialog('Incoming transfer');
      await b.declineIncoming();
      await a.waitForBodyText('declined the transfer', 30000);
      const body = await b.bodyText();
      assert(!body.includes('declined-me.txt') || !body.includes('Download'), 'receiver kept the declined file');
    });

    await check('the sender can cancel a transfer in flight', async () => {
      await a.dismissDialogs();
      await b.dismissDialogs();
      // A larger file gives us a window to cancel mid-flight.
      const big = new Uint8Array(12 * 1024 * 1024);
      for (let index = 0; index < big.length; index += 4096) big[index] = index % 255;
      const bigPath = join(ARTIFACT_DIR, 'big-payload.bin');
      writeFileSync(bigPath, big);

      await a.addFiles([bigPath]);
      await a.waitForQueued(1);
      await a.clickSendForQueue();
      await a.chooseDeviceInDialog(peerNameForA);
      await b.acceptIncoming();

      await waitFor(
        async () => {
          const body = await a.bodyText();
          return /Sending to/.test(body) && /%/.test(body);
        },
        { message: 'the transfer to start' },
      );
      await a.clickButton('^Cancel$');
      await Promise.all([a.waitForBodyText('Transfer cancelled', 20000), b.waitForBodyText('cancelled', 20000)]);
    });

    /* --------------------------- large file support --------------------------- */
    console.log('\nLarge file handling');
    let largeTransferLogs = null;
    await check('a large file transfers intact with chunking and backpressure', async () => {
      await a.dismissDialogs();
      await b.dismissDialogs();
      const large = new Uint8Array(20 * 1024 * 1024);
      for (let index = 0; index < large.length; index += 1021) large[index] = (index * 7) % 256;
      const largePath = join(ARTIFACT_DIR, 'large.bin');
      writeFileSync(largePath, large);
      const expected = sha256(Buffer.from(large));

      // Start fresh sample logs so the strict assertions below cover *this* transfer.
      await Promise.all([a.startProgressRecorder(), b.startProgressRecorder()]);
      await a.addFiles([largePath]);
      await a.waitForQueued(1);
      await a.clickSendForQueue();
      await a.chooseDeviceInDialog(peerNameForA);
      await b.acceptIncoming();
      // Finished transfers from earlier checks stay on screen, so wait for a row
      // that actually belongs to large.bin *and* is complete (it has its own button).
      await b.waitForReceivedFile('large.bin', 90000);
      const largeRow = (await b.bodyText()).includes('large.bin');
      assert(largeRow, 'large.bin missing from the receiver list');
      largeTransferLogs = await Promise.all([a.progressLog(), b.progressLog()]);

      const downloaded = await withDownloadCapture(pageB, downloadDir, async () => {
        const before = new Set(readdirSync(downloadDir));
        const clicked = await pageB.evaluate(() => {
          const rows = Array.from(document.querySelectorAll('li'));
          const row = rows.find((item) => item.textContent?.includes('large.bin'));
          const button = Array.from(row?.querySelectorAll('button') ?? []).find((candidate) =>
            /Download/.test(candidate.getAttribute('aria-label') ?? ''),
          );
          if (!button) return false;
          button.click();
          return true;
        });
        assert(clicked, 'download button for large.bin missing');
        return waitForDownload(downloadDir, before, 90000);
      });
      assert(sha256(readFileSync(downloaded)) === expected, 'large file hash mismatch');
    });

    /* ------------------------------- other UI ------------------------------- */
    console.log('\nInterface');
    await check('the sender streams a large file instead of buffering it in memory', async () => {
      await a.dismissDialogs();
      await b.dismissDialogs();
      const sizeMB = 64;
      const bytes = new Uint8Array(sizeMB * 1024 * 1024);
      for (let index = 0; index < bytes.length; index += 4099) bytes[index] = (index * 13) % 256;
      const streamPath = join(ARTIFACT_DIR, 'stream-payload.bin');
      writeFileSync(streamPath, bytes);

      // Baseline with a clean heap: this is the reference the peak is measured against.
      const baseline = await pageA.evaluate(() => {
        window.gc?.();
        return performance.memory?.usedJSHeapSize ?? null;
      });
      assert(baseline !== null, 'performance.memory is unavailable, so memory flatness cannot be measured');
      await pageA.evaluate(() => {
        const state = { peak: 0, samples: 0, timer: 0 };
        window.__heap = state;
        state.timer = window.setInterval(() => {
          state.samples += 1;
          state.peak = Math.max(state.peak, performance.memory?.usedJSHeapSize ?? 0);
        }, 100);
      });

      await a.addFiles([streamPath]);
      await a.waitForQueued(1);
      await a.clickSendForQueue();
      await a.chooseDeviceInDialog(peerNameForA);
      await b.acceptIncoming();
      await b.waitForReceivedFile('stream-payload.bin', 120000);

      const heap = await pageA.evaluate(() => {
        const state = window.__heap;
        if (!state) return null;
        window.clearInterval(state.timer);
        window.gc?.();
        return { peak: state.peak, samples: state.samples, settled: performance.memory?.usedJSHeapSize ?? 0 };
      });
      assert(heap && heap.samples > 20, `the heap sampler barely ran (${heap?.samples ?? 0} samples)`);

      const growthMB = (heap.peak - baseline) / (1024 * 1024);
      const budgetMB = sizeMB / 2; // a whole-file buffer would be ≥ 64 MB; half is a safe line
      console.log(
        `     heap: baseline ${(baseline / 1048576).toFixed(1)} MB → peak ${(heap.peak / 1048576).toFixed(1)} MB ` +
          `(+${growthMB.toFixed(1)} MB while sending ${sizeMB} MB in ${heap.samples} samples; settled ${(heap.settled / 1048576).toFixed(1)} MB)`,
      );
      assert(
        growthMB < budgetMB,
        `the sender's heap grew by ${growthMB.toFixed(1)} MB while sending a ${sizeMB} MB file (budget ${budgetMB} MB) — that looks like whole-file buffering`,
      );
      // The transfer must have actually happened (otherwise "no memory growth" is meaningless).
      assert((await b.bodyText()).includes('stream-payload.bin'), 'the streamed file never arrived on the receiver');
    });

    await check('both sides render live progress, speed and ETA during the large transfer', async () => {
      assert(largeTransferLogs, 'the large transfer did not run (no sample logs)');
      const [senderLog, receiverLog] = largeTransferLogs;
      // A 20 MB payload streams for seconds, so both sides must have painted real progress.
      assert(
        senderLog.percent.length > 0,
        `the sender never rendered a progress percentage (${progressDigest(senderLog)})`,
      );
      assert(
        receiverLog.percent.length > 0,
        `the receiver never rendered a progress percentage (${progressDigest(receiverLog)})`,
      );
      assert(
        receiverLog.speed.length > 0 || receiverLog.eta.length > 0,
        `the receiver never rendered a speed or ETA readout (${progressDigest(receiverLog)})`,
      );
      assert(
        senderLog.speed.length > 0 || senderLog.eta.length > 0,
        `the sender never rendered a speed or ETA readout (${progressDigest(senderLog)})`,
      );
    });

    await check('theme switching and persistence work', async () => {
      await a.dismissDialogs();
      const before = await pageA.evaluate(() => document.documentElement.dataset.themePreference);
      // Cycle until the resolved theme is dark, then reload and confirm persistence.
      for (let index = 0; index < 3; index += 1) {
        const resolved = await pageA.evaluate(() => document.documentElement.dataset.theme);
        if (resolved === 'dark') break;
        const clicked = await pageA.evaluate(() => {
          const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
            /Theme:/i.test(candidate.getAttribute('aria-label') ?? ''),
          );
          if (!button) return false;
          button.click();
          return true;
        });
        assert(clicked, 'theme button missing');
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      const preference = await pageA.evaluate(() => document.documentElement.dataset.themePreference);
      const resolved = await pageA.evaluate(() => document.documentElement.dataset.theme);
      assert(resolved === 'dark', `expected a dark theme after cycling, saw ${resolved}`);
      assert(preference !== before || resolved === 'dark', 'theme preference did not change');

      await pageA.reload({ waitUntil: 'domcontentloaded' });
      await a.waitForApp();
      await waitFor(
        async () => (await pageA.evaluate(() => document.documentElement.dataset.theme)) === 'dark',
        { message: 'the saved dark theme to be restored after reload' },
      );
    });

    await check('the QR pairing dialog renders a code and room id', async () => {
      await a.dismissDialogs();
      const clicked = await pageA.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (candidate) => candidate.getAttribute('aria-label') === 'Pair another device',
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(clicked, 'QR button missing');
      await pageA.waitForSelector('[role="dialog"] img[alt*="QR"]', { timeout: 15000 });
      const dialogText = (await a.dialogByTitle('Pair another device')) ?? '';
      assert(/Room code/.test(dialogText), 'room code missing from the pairing dialog');
      assert(/[A-Z0-9]{4,}/.test(dialogText), 'room id missing from the pairing dialog');
      assert(/Copy link/.test(dialogText), 'room link action missing');
      await pageA.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    await check('settings expose theme, device name, privacy and about', async () => {
      await a.dismissDialogs();
      const clicked = await pageA.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (candidate) => candidate.getAttribute('aria-label') === 'Settings',
        );
        if (!button) return false;
        button.click();
        return true;
      });
      assert(clicked, 'settings button missing');
      await a.waitForDialog('Settings');
      const dialogText = (await a.dialogByTitle('Settings')) ?? '';
      assert(dialogText.includes('Appearance'), 'settings panel is missing “Appearance”');
      for (const needle of [
        'Appearance',
        'Device name',
        'Notifications',
        'Auto-accept transfers',
        'Download behaviour',
        'Transfer history',
        'Privacy',
        'About',
        'Muhammad Anas',
      ]) {
        assert(dialogText.includes(needle), `settings panel is missing “${needle}”`);
      }
      await pageA.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 200));
    });

    await check('the interface passes an automated accessibility audit', async () => {
      if (!axeCorePath()) {
        assert(false, 'axe-core is missing — run `npm ci` so the audit can run');
      }
      // Audit the *settled* UI: entrance animations fade text in from 0 opacity, and a
      // measurement taken mid-fade is not a rendering anyone reads for long (axe caught
      // exactly that once: muted text at ~73 % opacity, ratio 4.42). The app already sets
      // animation/transition durations to ~0 under `prefers-reduced-motion: reduce`
      // (src/index.css), so emulating it makes the audit deterministic *and* exercises the
      // reduced-motion path users ask for.
      await pageA.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
      const reports = [await auditAccessibility(pageA, 'desktop main view')];
      // The settings sheet is a dialog: audit it open, not just the page behind it.
      await a.clickAriaButton('Settings');
      await a.waitForDialog('Settings');
      reports.push(await auditAccessibility(pageA, 'desktop settings sheet'));
      await pageA.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 200));

      // A phone-sized viewport is a different layout: audit it too and require that the
      // page never scrolls sideways.
      await pageA.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      try {
        await new Promise((resolve) => setTimeout(resolve, 400));
        const overflow = await pageA.evaluate(() => ({
          scrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
        }));
        assert(
          overflow.scrollWidth <= overflow.innerWidth + 1,
          `the mobile layout scrolls sideways (${overflow.scrollWidth}px wide in a ${overflow.innerWidth}px viewport)`,
        );
        const mobileBody = await a.bodyText();
        assert(mobileBody.includes('Select files'), 'the file picker is not reachable at mobile width');
        assert(mobileBody.includes(peerNameForA), 'the nearby device card is missing at mobile width');
        reports.push(await auditAccessibility(pageA, 'mobile main view'));
        await a.clickAriaButton('Settings');
        await a.waitForDialog('Settings');
        const sheet = await pageA.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const rect = dialog?.getBoundingClientRect();
          return rect ? { left: rect.left, right: rect.right, width: window.innerWidth } : null;
        });
        assert(sheet, 'the settings sheet did not open at mobile width');
        assert(
          sheet.left >= -1 && sheet.right <= sheet.width + 1,
          `the settings sheet overflows the mobile viewport (${JSON.stringify(sheet)})`,
        );
        reports.push(await auditAccessibility(pageA, 'mobile settings sheet'));
        await pageA.keyboard.press('Escape');
        await new Promise((resolve) => setTimeout(resolve, 200));

        // A fresh session is the only way to audit the boot overlay and the first
        // connection state (banner + status chip) — both used to be invisible to CI.
        const bootContext = await browser.createBrowserContext();
        const bootPage = await bootContext.newPage();
        await bootPage.setViewport({ width: 1280, height: 900 });
        await bootPage.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
        try {
          await bootPage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
          await new Promise((resolve) => setTimeout(resolve, 250));
          reports.push(await auditAccessibility(bootPage, 'boot overlay'));
          await new Promise((resolve) => setTimeout(resolve, 2500));
          reports.push(await auditAccessibility(bootPage, 'fresh session (connecting banner + chip)'));

          // Dark theme and the offline banner are audited on this throwaway page on
          // purpose: page A/B are mid-suite and must not be perturbed (a real offline
          // excursion on them used to leave stale links that slowed the later reconnect
          // check). The attribute is set directly because this page is discarded.
          await bootPage.evaluate(() => {
            document.documentElement.dataset.theme = 'dark';
          });
          await new Promise((resolve) => setTimeout(resolve, 300));
          reports.push(await auditAccessibility(bootPage, 'dark theme'));
          await bootPage.setOfflineMode(true);
          try {
            await waitFor(
              async () => (await bootPage.evaluate(() => document.body.innerText)).includes('Network unavailable'),
              { timeout: 8000, message: 'the offline banner to appear' },
            );
          } catch {
            /* the audit below still runs on whatever state is on screen */
          }
          reports.push(await auditAccessibility(bootPage, 'offline (danger banner)'));
        } finally {
          await bootPage.close().catch(() => undefined);
          await bootContext.close().catch(() => undefined);
        }

        const blocking = reports.flatMap((report) =>
          report.violations
            .filter((violation) => violation.impact === 'critical' || violation.impact === 'serious')
            .map(
              (violation) =>
                `${report.label} [${violation.theme}]: ${violation.impact} ${violation.id} ×${violation.count} — ${violation.html}` +
                `${violation.contrast ? `\n       ${violation.contrast}` : ''}`,
            ),
        );
        const total = reports.reduce((sum, report) => sum + report.violations.length, 0);
        if (total > 0) {
          const summary = reports
            .filter((report) => report.violations.length > 0)
            .map((report) => `${report.label}: ${report.violations.map((v) => `${v.impact} ${v.id}×${v.count}`).join(', ')}`)
            .join(' | ');
          console.log(`     axe-core reported ${total} violation type(s): ${summary}`);
        } else {
          console.log(`     axe-core: no violations across ${reports.length} surfaces (desktop, mobile, boot, dark, offline; page A untouched)`);
        }
        assert(blocking.length === 0, `accessibility violations:\n     ${blocking.join('\n     ')}`);
      } finally {
        await pageA.setViewport({ width: 1280, height: 900 });
        await pageA.emulateMediaFeatures([]);
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    });

    await check('transfer history is stored locally and can be cleared', async () => {
      await b.dismissDialogs();
      const readHistoryStore = () =>
        pageB.evaluate(
          () =>
            new Promise((resolve) => {
              const request = indexedDB.open('lanshare', 1);
              request.onerror = () => resolve(null);
              request.onsuccess = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('history')) {
                  db.close();
                  resolve(null);
                  return;
                }
                const all = db.transaction('history', 'readonly').objectStore('history').getAll();
                all.onsuccess = () => {
                  const entries = all.result ?? [];
                  db.close();
                  resolve(entries.map((entry) => ({ names: entry?.fileNames ?? [], status: entry?.status })));
                };
                all.onerror = () => {
                  db.close();
                  resolve(null);
                };
              };
            }),
        );

      // The earlier transfers must be persisted to IndexedDB (metadata only).
      const stored = await waitForValue(async () => {
        const entries = await readHistoryStore();
        return Array.isArray(entries) && entries.length > 0 ? entries : null;
      }, 'transfer history to be written to IndexedDB');
      assert(
        JSON.stringify(stored).includes('large.bin'),
        `history did not persist the received file names (${JSON.stringify(stored).slice(0, 120)})`,
      );

      const before = await b.bodyText();
      assert(/Recent/.test(before), 'history section missing on the receiver');

      await b.clickButton('^Clear history$');
      await waitFor(async () => !(await b.bodyText()).includes('Clear history'), {
        message: 'the history list to disappear after clearing',
      });
      const afterClear = await readHistoryStore();
      assert(
        Array.isArray(afterClear) && afterClear.length === 0,
        'clearing history did not empty the IndexedDB store',
      );
    });

    await check('the footer credits the author', async () => {
      // Target the app's own <footer> rather than "somewhere on the page": the credit has to
      // survive in the rendered UI, not just in metadata or the static shell.
      const footer = await pageA.evaluate(() => document.querySelector('footer')?.innerText ?? '');
      assert(
        footer.includes('Built by Muhammad Anas'),
        `author credit missing from the rendered footer (footer text: "${footer.replace(/\s+/g, ' ').slice(0, 120)}")`,
      );
    });

    await check('the PWA manifest and service worker are served', async () => {
      const manifest = await fetch(`${BASE_URL}manifest.webmanifest`).then((response) => response.json());
      assert(manifest.name?.includes('LANShare'), 'manifest name missing');
      assert(Array.isArray(manifest.icons) && manifest.icons.length >= 3, 'manifest icons missing');
      assert(manifest.share_target?.action, 'share target missing');
      const sw = await fetch(`${BASE_URL}sw.js`);
      assert(sw.ok, 'service worker not served');
      const icon = await fetch(`${BASE_URL}icons/icon-512.png`);
      assert(icon.ok && icon.headers.get('content-type')?.includes('image/png'), 'icon not served as PNG');
    });

    await check('a browser without WebRTC gets an honest unsupported screen', async () => {
      const context = await browser.createBrowserContext();
      const page = await context.newPage();
      try {
        // Remove the primitives the capability check looks for, before any app code runs.
        await page.evaluateOnNewDocument(() => {
          // eslint-disable-next-line no-delete-var
          delete window.RTCPeerConnection;
          delete window.webkitRTCPeerConnection;
        });
        await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
        const text = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
        assert(/cannot run LANShare/i.test(text), `expected the unsupported screen, saw: ${text.slice(0, 120)}`);
        assert(/WebRTC/.test(text), 'the screen does not name the missing capability');
        assert(/Built by Muhammad Anas/.test(text), 'the unsupported screen dropped the author credit');
        assert(!/Share anything nearby/.test(text), 'the app booted anyway instead of stopping at the capability check');
      } finally {
        await page.close().catch(() => undefined);
        await context.close().catch(() => undefined);
      }
    });

    await check('no notification permission prompt on load and auto-accept defaults to off', async () => {
      // `Notification.permission` is 'default' until something asks. Headless Chrome answers
      // a prompt itself (auto-deny), so 'default' after a whole session proves the app never
      // asked — the permission must only be requested when the user switches notifications on.
      const state = await pageA.evaluate(() => ({
        permission: typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
      }));
      assert(
        state.permission === 'default' || state.permission === 'unsupported',
        `the app requested notification permission without being asked (permission is "${state.permission}")`,
      );

      // Auto-accept must be off out of the box: the receiver still has to approve every
      // transfer (which the consent check above proved), and the switch must read as off.
      const autoAccept = await pageA.evaluate(async () => {
        const button = Array.from(document.querySelectorAll('button')).find(
          (candidate) => candidate.getAttribute('aria-label') === 'Settings',
        );
        button?.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        // Target the switch by its own accessible name: the sheet holds several toggles.
        const toggle = document.querySelector('button[role="switch"][aria-label="Auto-accept incoming transfers"]');
        const row = toggle?.closest('section');
        return {
          found: Boolean(toggle),
          checked: toggle?.getAttribute('aria-checked') ?? null,
          description: (row?.textContent ?? '').replace(/\s+/g, ' ').slice(0, 80),
        };
      });
      await pageA.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert(autoAccept.found, 'the auto-accept switch was not found in settings');
      assert(
        autoAccept.checked === 'false',
        `auto-accept is not off by default (aria-checked=${autoAccept.checked})`,
      );
      await pageA.keyboard.press('Escape');
    });

    await check('renaming this device is announced to the other device', async () => {
      const newName = 'Renamed Otter';
      // A rename travels to the other device over the live data channel, so first require that
      // channel to exist: the preceding checks include a 64 MB transfer, a cancellation and a
      // declined transfer, and the transport can still be recovering from one of them. A rename
      // cannot be confirmed over a channel that is not there yet — and when such a link is
      // rebuilt, the app re-announces whose current name on channel open, so waiting here costs
      // nothing and removes a flake that had nothing to do with renaming.
      await waitForValue(
        async () => {
          const snapshot = await b.snapshot();
          return snapshot.links.some((link) => link.ctl === 'open' && link.bin === 'open');
        },
        'device B to have a usable data channel before the rename',
        30000,
      );
      await a.clickAriaButton('Settings');
      await a.waitForDialog('Settings');
      const typed = await pageA.evaluate(() => {
        const input = document.querySelector('input[aria-label="Device name shown to nearby devices"]');
        if (!input) return false;
        input.focus();
        input.select?.();
        return true;
      });
      assert(typed, 'the device name input was not found');
      await pageA.keyboard.down('Control');
      await pageA.keyboard.press('KeyA');
      await pageA.keyboard.up('Control');
      await pageA.keyboard.type(newName, { delay: 20 });
      await pageA.keyboard.press('Enter');
      await pageA.keyboard.press('Escape');
      await new Promise((resolve) => setTimeout(resolve, 400));

      // The other device sees the new name through the HELLO re-announcement.
      await waitFor(
        async () => (await b.bodyText()).includes(newName),
        { timeout: 20000, message: `device B to show the renamed device “${newName}”` },
      ).catch(async (error) => {
        throw new Error(`${error.message} (B still sees: ${(await b.bodyText()).slice(0, 160).replace(/\s+/g, ' ')})`);
      });
      // The name must reach the other device over *both* channels: the signalling
      // PEER_UPDATED broadcast (the device list) and the in-band HELLO re-announcement on
      // the live data channel (the link identity). The two travel independently, and the
      // wait above only covers the list — so asserting the identity straight after it read
      // the data channel mid-flight and reported a null identity on a slower machine. That
      // is a race in the check, not in the app: wait for the transport fact on its own.
      const announced = await waitForValue(
        async () => {
          const snapshot = await b.snapshot();
          return snapshot.links.some((link) => link.identity === newName) ? snapshot : null;
        },
        `device B to receive the renamed device over the data channel (identity “${newName}”)`,
      ).catch(async (error) => {
        // Report *both* sides' transport state, not just the missing name: whether the link is
        // open but never received the HELLO, or open on one side only, changes what is wrong.
        const [snapshotB, snapshotA] = await Promise.all([b.snapshot(), a.snapshot()]);
        const describe = (snapshot) =>
          snapshot.links
            .map((link) => `${link.identity?.name ?? 'null'}/ctl=${link.ctl}/bin=${link.bin}/status=${link.status}`)
            .join(', ');
        throw new Error(
          `${error.message}\n        why? page B links: [${describe(snapshotB)}]\n` +
            `              page A links: [${describe(snapshotA)}]`,
        );
      });
      assert(
        announced.peers.some((peer) => peer.name === newName),
        `the device list on the other side still shows ${JSON.stringify(announced.peers.map((peer) => peer.name))}`,
      );

      // And the rename is persisted locally.
      const stored = await pageA.evaluate(() => {
        for (let index = 0; index < window.localStorage.length; index += 1) {
          const key = window.localStorage.key(index);
          if (!key) continue;
          try {
            const parsed = JSON.parse(window.localStorage.getItem(key) ?? '{}');
            if (parsed && typeof parsed === 'object' && 'displayName' in parsed) return parsed.displayName;
          } catch {
            /* not JSON */
          }
        }
        return null;
      });
      assert(stored === newName, `the new name was not persisted (stored: ${stored})`);
    });

    await check('a private room code pairs two devices away from the default room', async () => {
      const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const code = `E2E${Array.from({ length: 3 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('')}`;
      const contextC = await browser.createBrowserContext();
      const contextD = await browser.createBrowserContext();
      const pageC = await contextC.newPage();
      const pageD = await contextD.newPage();
      try {
        for (const page of [pageC, pageD]) {
          await page.setViewport({ width: 1280, height: 900 });
          await page.goto(`${BASE_URL}?room=${code}&debug=1`, { waitUntil: 'domcontentloaded' });
          for (let index = 0; index < 24; index += 1) {
            const clicked = await page
              .evaluate(() => {
                const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
                  /^Continue$/.test(candidate.textContent?.trim() ?? ''),
                );
                if (!button) return false;
                button.click();
                return true;
              })
              .catch(() => false);
            if (clicked) break;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        const roomOf = (page) =>
          page.evaluate(() => {
            const state = globalThis.__lanshare?.snapshot?.();
            return { roomId: state?.roomId ?? null, selfId: state?.selfId ?? null };
          });
        let rooms = null;
        await waitFor(
          async () => {
            const [c, d] = await Promise.all([roomOf(pageC), roomOf(pageD)]);
            if (!c.roomId || !d.roomId) return false;
            rooms = { c, d };
            return true;
          },
          { timeout: 20000, message: 'both pages to receive a room id' },
        );
        assert(rooms.c.roomId === code, `the first device landed in ${rooms.c.roomId}, not ${code}`);
        assert(rooms.d.roomId === code, `the second device landed in ${rooms.d.roomId}, not ${code}`);

        // They must find each other even though the default room is busy with other peers.
        await waitFor(
          async () => {
            const [c, d] = await Promise.all([
              pageC.evaluate(() => {
                const state = globalThis.__lanshare?.snapshot?.();
                return Boolean(state?.links?.some((link) => link.ctl === 'open' && link.bin === 'open'));
              }),
              pageD.evaluate(() => {
                const state = globalThis.__lanshare?.snapshot?.();
                return Boolean(state?.links?.some((link) => link.ctl === 'open' && link.bin === 'open'));
              }),
            ]);
            return c && d;
          },
          { timeout: 40000, message: 'the two private-room devices to connect' },
        );
        const peersInRoom = await pageC.evaluate(() => globalThis.__lanshare?.snapshot?.().peers.length ?? 0);
        assert(peersInRoom === 1, `expected exactly one peer in the private room, saw ${peersInRoom}`);
      } finally {
        await pageC.close().catch(() => undefined);
        await pageD.close().catch(() => undefined);
        await contextC.close().catch(() => undefined);
        await contextD.close().catch(() => undefined);
      }
    });

    await check('an OS share reaches the app through the share target', async () => {
      // 1. Live path: the OS share sheet POSTs multipart/form-data to the manifest's
      //    share_target, the service worker parks it and pings the open app, which queues
      //    the file and puts shared text in the Text tab. The POST below is the same request
      //    the OS makes — it travels through the real service worker.
      const controlled = await pageA.evaluate(async () => {
        if (navigator.serviceWorker.controller) return true;
        await navigator.serviceWorker.ready.catch(() => null);
        return Boolean(navigator.serviceWorker.controller);
      });
      assert(controlled, 'the page is not controlled by the service worker, so a share could not reach it');

      await a.dismissDialogs();
      const shared = await pageA.evaluate(async () => {
        const form = new FormData();
        form.append('title', 'Shared from the OS');
        form.append('text', 'Shared text from the OS share sheet');
        form.append(
          'files',
          new File([new Uint8Array([7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7])], 'shared-from-os.bin', {
            type: 'application/octet-stream',
          }),
        );
        const response = await fetch('share-target', { method: 'POST', body: form });
        return { ok: response.ok, url: response.url, status: response.status };
      });
      assert(shared.ok, `the share POST failed (HTTP ${shared.status})`);
      assert(
        shared.url.includes('share=1'),
        `the service worker did not redirect back into the app (landed on ${shared.url})`,
      );

      await waitFor(
        async () => (await a.bodyText()).includes('shared-from-os.bin'),
        { timeout: 20000, message: 'the shared file to appear in the queue' },
      );
      const queueText = await a.bodyText();
      assert(queueText.includes('Selected files'), 'the shared file was not queued');
      const parkEmpty = await pageA.evaluate(async () => {
        const cache = await caches.open('lanshare-incoming-share');
        return (await cache.keys()).length;
      });
      assert(parkEmpty === 0, `the parked share payload was not consumed (${parkEmpty} entries left)`);

      // 2. Load path: the same payload parked while the app is closed must be collected on
      //    load (`?share=1`), and the query parameter cleaned up afterwards.
      const shareContext = await browser.createBrowserContext();
      const sharePage = await shareContext.newPage();
      try {
        await sharePage.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
        const seeded = await sharePage.evaluate(async () => {
          await navigator.serviceWorker.ready.catch(() => null);
          const cache = await caches.open('lanshare-incoming-share');
          await cache.put(
            new Request('incoming-file-text', { method: 'GET' }),
            new Response('Text parked while the app was closed', { status: 200 }),
          );
          return true;
        });
        assert(seeded, 'could not park a share payload for the load path');
        await sharePage.goto(`${BASE_URL}?share=1`, { waitUntil: 'domcontentloaded' });
        await waitFor(
          async () =>
            sharePage.evaluate(() => {
              const textarea = document.querySelector('textarea');
              return Boolean(textarea && /Text parked while the app was closed/.test(textarea.value));
            }),
          { timeout: 20000, message: 'the parked text to be collected on load' },
        ).catch((error) => {
          throw new Error(`the load-time share was not collected: ${error.message}`);
        });
        const cleaned = await sharePage.evaluate(async () => {
          const cache = await caches.open('lanshare-incoming-share');
          const leftover = (await cache.keys()).length;
          return { leftover, url: window.location.href };
        });
        assert(cleaned.leftover === 0, `the parked text was not cleared (${cleaned.leftover} entries left)`);
        assert(!cleaned.url.includes('share=1'), `the share query parameter was left in the URL (${cleaned.url})`);
      } finally {
        await sharePage.close().catch(() => undefined);
        await shareContext.close().catch(() => undefined);
      }

      // Leave the queue empty for the checks that follow.
      await pageA.evaluate(() => {
        const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
          /^Clear all$/.test(candidate.textContent?.trim() ?? ''),
        );
        button?.click();
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });

    await check('the app boots inside a sandboxed, storage-blocked frame (embedded preview)', async () => {
      // A frame with `sandbox="allow-scripts"` has an opaque origin: reading
      // `window.localStorage` throws, and its module-script requests carry `Origin: null`
      // (so the host must answer with CORS headers). Neither may take the app down — the
      // shell must render, signalling must connect, and the settings sheet must be honest
      // about preferences not being persisted in this context.
      const embedContext = await browser.createBrowserContext();
      const embedPage = await embedContext.newPage();
      const embedErrors = [];
      embedPage.on('console', (message) => {
        if (message.type() === 'error') embedErrors.push(message.text());
      });
      embedPage.on('pageerror', (error) => embedErrors.push(`pageerror: ${error.message}`));
      try {
        await embedPage.setViewport({ width: 1280, height: 900 });
        await embedPage.setContent(
          `<!doctype html><html><body style="margin:0"><iframe sandbox="allow-scripts" src="${BASE_URL}" style="width:1100px;height:820px;border:0"></iframe></body></html>`,
          { waitUntil: 'domcontentloaded' },
        );
        const frame = await waitForValue(
          async () => {
            const candidate = embedPage
              .frames()
              .find((candidateFrame) => candidateFrame !== embedPage.mainFrame() && candidateFrame.url().startsWith(BASE_URL));
            if (!candidate) return null;
            const ready = await candidate
              .evaluate(() => /Nearby devices/i.test(document.body.innerText))
              .catch(() => false);
            return ready ? candidate : null;
          },
          'the embedded app shell to render',
          30000,
        );

        const storage = await frame.evaluate(() => {
          try {
            window.localStorage.setItem('e2e.embed', '1');
            return 'available';
          } catch (error) {
            return error.name;
          }
        });
        assert(storage === 'SecurityError', `expected blocked storage in the sandboxed frame, saw ${storage}`);

        const text = await frame.evaluate(() => document.body.innerText);
        assert(!/Something went wrong/.test(text), 'the error boundary replaced the app inside the sandboxed frame');

        await waitFor(
          async () =>
            frame.evaluate(() => /Ready to receive|\d+ connected/.test(document.body.innerText)),
          { timeout: 20000, message: 'signalling to connect inside the sandboxed frame' },
        );

        const opened = await frame.evaluate(() => {
          const button = document.querySelector('button[aria-label="Settings"]');
          if (!button) return false;
          button.click();
          return true;
        });
        assert(opened, 'the settings button was not found inside the sandboxed frame');
        await waitFor(async () => frame.evaluate(() => /session only/.test(document.body.innerText)), {
          message: 'the settings sheet to explain that preferences are session-only here',
        });

        assert(
          embedErrors.length === 0,
          `console errors inside the sandboxed frame: ${embedErrors.slice(0, 4).join(' | ')}`,
        );
      } finally {
        await embedPage.close().catch(() => undefined);
        await embedContext.close().catch(() => undefined);
      }
    });

    await check('no uncaught console errors during the whole session', async () => {
      const relevant = consoleErrors.filter(
        (message) =>
          !/favicon|Download the React DevTools|net::ERR_|WebSocket connection|Failed to load resource/i.test(message),
      );
      assert(relevant.length === 0, `console errors: ${relevant.slice(0, 4).join(' | ')}`);
    });
    await check('the offline shell loads without a network and the app reconnects', async () => {
      // Phase timings make a slow-but-passing reconnect readable instead of a mystery
      // (they are printed for every run; per-sample snapshots need E2E_TRACE_RECONNECT=1).
      const phaseStarted = Date.now();
      const phases = [];
      const phase = (label) => phases.push(`${label} ${((Date.now() - phaseStarted) / 1000).toFixed(1)}s`);
      const trace = [];
      const traceTimer = process.env.E2E_TRACE_RECONNECT
        ? setInterval(async () => {
            const [stateA, stateB] = await Promise.all([a.snapshot(), b.snapshot()]);
            const link = (state) => (state?.links ?? []).map((entry) => `init=${entry.initiator} st=${entry.status} ctl=${entry.ctl}`).join(',');
            trace.push(
              `  +${((Date.now() - phaseStarted) / 1000).toFixed(1)}s  A[${stateA?.selfId ?? '-'} ${stateA?.signalingState ?? '-'} ${link(stateA)}]  B[${stateB?.selfId ?? '-'} ${stateB?.signalingState ?? '-'} ${link(stateB)}]`,
            );
          }, 500)
        : null;

      // The service worker must control the page before anything can be served offline.
      const controlled = await pageA.evaluate(async () => {
        if (!('serviceWorker' in navigator)) return false;
        const registration = await navigator.serviceWorker.ready.catch(() => null);
        if (!registration) return false;
        if (navigator.serviceWorker.controller) return true;
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 6000);
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
        return Boolean(navigator.serviceWorker.controller);
      });
      assert(controlled, 'the service worker never took control of the page');
      phase('service-worker');

      const cachedAssets = await pageA.evaluate(async () => {
        const cache = await caches.open('lanshare-shell-v2');
        const keys = await cache.keys();
        return keys.map((request) => new URL(request.url).pathname);
      });
      assert(
        cachedAssets.some((path) => path.endsWith('.js')),
        `the shell cache holds no scripts (${cachedAssets.length} entries)`,
      );
      phase('shell-cache');

      await pageA.setOfflineMode(true);
      try {
        await pageA.reload({ waitUntil: 'domcontentloaded' });
        phase('offline-reload');
        await a.waitForBodyText('LANShare', 20000);
        const shell = await a.bodyText();
        assert(shell.includes('Built by Muhammad Anas'), 'the offline shell rendered without the app UI');
        phase('offline-shell');

        // Still offline: the app has to know it is disconnected (no fake "Connected" state).
        const offlineState = await waitForValue(async () => {
          const state = await a.snapshot();
          if (!state || state.signalingState === 'connected') return null;
          const banner = /Connecting…|Reconnecting…/.test(await a.bodyText());
          return { state, banner };
        }, 'the app to report the lost connection while it is offline', 15000);
        assert(
          offlineState.state.signalingState !== 'connected',
          'the app still claimed a live signaling connection while the network was off',
        );
        if (!offlineState.banner) {
          console.log('     (no “Connecting…” banner was sampled while offline; the app recovered before the next paint)');
        }
      } finally {
        await pageA.setOfflineMode(false);
        phase('back-online');
      }

      // Back online: the signaling client must reconnect on its own and rediscover
      // the other device (this is the reconnect-with-backoff path, not a page reload).
      await a.waitForApp();
      phase('app-booted');
      // Coming back must be automatic and quick: every phase above happens in well under a
      // second, so a 20 s ceiling here is a real signal rather than a generous net.
      await a.waitForDataChannel(20000);
      phase('data-channel');
      const names = await a.deviceNames();
      assert(names.length > 0, 'no devices were rediscovered after coming back online');
      if (traceTimer) clearInterval(traceTimer);
      console.log(`     phases: ${phases.join(' · ')}`);
      if (trace.length) console.log(`     trace:\n${trace.join('\n')}`);
    });

  } finally {
    if (failures > 0) {
      // A red run must leave evidence behind: CI uploads this directory as an artefact.
      await Promise.all(
        [
          ['pageA', pageA],
          ['pageB', pageB],
        ].map(async ([label, page]) => {
          if (page.isClosed()) return;
          await page.screenshot({ path: join(ARTIFACT_DIR, `${label}.png`), fullPage: false }).catch(() => undefined);
          const state = await page
            .evaluate(() => {
              const snapshot = globalThis.__lanshare?.snapshot?.();
              return snapshot ? JSON.stringify(snapshot, null, 2) : '<no snapshot>';
            })
            .catch((error) => `<unavailable: ${error.message}>`);
          writeFileSync(join(ARTIFACT_DIR, `${label}-state.json`), state, 'utf8');
        }),
      );
      writeFileSync(
        join(ARTIFACT_DIR, 'summary.json'),
        JSON.stringify({ failures: results.filter((result) => !result.ok).map((result) => ({ name: result.name, error: result.error })) }, null, 2),
        'utf8',
      );
      console.error(`\n  artefacts kept for inspection: ${ARTIFACT_DIR}`);
    }
    await browser.close().catch(() => undefined);
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Chromium's default download folder is removed whether or not the run failed — it is
    // not diagnostics, and leaving empty directories behind is just litter.
    cleanupDefaultDownloadsDir();
    if (failures === 0) cleanupArtifacts();
  }

  /* ------------------------------- summary ------------------------------- */
  console.log('\n───────────────────────');
  const passed = results.filter((result) => result.ok).length;
  console.log(`E2E result: ${passed}/${results.length} checks passed`);
  if (failures > 0) {
    console.error(`\n${failures} check(s) failed:`);
    for (const result of results.filter((entry) => !entry.ok)) {
      console.error(`  ✗ ${result.name}\n     ${result.error}`);
    }
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    // Timers/child handles can keep the loop alive; exit deliberately.
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('\nE2E harness error:', error.message);
    process.exit(1);
  });
