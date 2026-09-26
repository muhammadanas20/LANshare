/**
 * LANShare reconnect regression test.
 *
 * Reproduces the hardest real-world reconnect: a device is mid-session and its page is
 * reloaded, so *its* old peer connection dies while the other device still holds the
 * link. Which side dials is decided by peer id (`isDialer`), so the interesting case is
 * the one where the device that did **not** reload keeps owning the dialer link: its
 * transport may be re-established by signalling/ICE, but its data channels are gone for
 * good and only a rebuilt link (fresh peer connection + fresh `ctl`/`bin` channels) can
 * carry traffic again.
 *
 * Because the sessions ids are random per connection, this script keeps drawing pairs
 * until it lands on that exact ordering and then asserts the app recovers on its own —
 * no page reload on the survivor's side, no manual retry.
 *
 * Requirements: `npm run build` and `npm --prefix server run build` must have run, and
 * puppeteer must be installed (dev dependency or PUPPETEER_PATH).
 *
 * Usage: node scripts/e2e/reconnect.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SIGNALING_PORT = Number(process.env.E2E_SIGNALING_PORT ?? 8097);
const PREVIEW_PORT = Number(process.env.E2E_PREVIEW_PORT ?? 4185);
const BASE_URL = `http://localhost:${PREVIEW_PORT}/`;

const MAX_ATTEMPTS = Number(process.env.E2E_RECONNECT_ATTEMPTS ?? 24);
const RECOVERY_TIMEOUT_MS = Number(process.env.E2E_RECOVERY_TIMEOUT_MS ?? 25_000);
/**
 * The reloaded page stays offline for this long, which is longer than the survivor needs to
 * notice the dead channels and offer again — so that offer is guaranteed to be sent into a
 * session that no longer exists. Recovery then has to notice the lost offer and start over
 * (previously it waited ~40 s for ICE to fail).
 */
const OFFLINE_DWELL_MS = Number(process.env.E2E_OFFLINE_DWELL_MS ?? 12_000);

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
    `Puppeteer is required for the browser reconnect test.\nInstall it with \`npm i -D puppeteer\` or set PUPPETEER_PATH.\nTried:\n  ${errors.join('\n  ')}`,
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHttp(url, timeoutMs = 30_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* server not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${url}`);
    await sleep(300);
  }
}

/** Read the app's debug snapshot (available behind `?debug=1`). */
function snapshot(page) {
  return page
    .evaluate(() => {
      const state = globalThis.__lanshare?.snapshot?.();
      if (!state) return null;
      return {
        selfId: state.selfId,
        roomId: state.roomId,
        peers: state.peers.map((peer) => ({ id: peer.id, name: peer.name, status: peer.status, link: peer.link })),
        links: (state.links ?? []).map((link) => ({
          peerId: link.peerId,
          initiator: link.initiator,
          status: link.status,
          transport: link.connectionState,
          ctl: link.ctl,
          bin: link.bin,
        })),
      };
    })
    .catch(() => null);
}

const linkText = (state) =>
  (state?.links ?? [])
    .map((link) => `${link.peerId}:initiator=${link.initiator} status=${link.status} transport=${link.transport} ctl=${link.ctl} bin=${link.bin}`)
    .join(' · ') || '<no link>';

const isConnected = (state) =>
  Boolean(
    state &&
      state.peers.some((peer) => peer.status === 'connected' && peer.link === 'connected') &&
      state.links.some((link) => link.status === 'connected' && link.ctl === 'open' && link.bin === 'open'),
  );

async function waitFor(check, timeoutMs, label) {
  const started = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - started > timeoutMs) {
      console.log(`  (timed out after ${timeoutMs} ms waiting for ${label})`);
      return null;
    }
    await sleep(500);
  }
}

async function dismissOnboarding(page) {
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
}

async function main() {
  console.log('\nLANShare reconnect regression test');
  console.log('─────────────────────────────────');

  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/index.html is missing — run `npm run build` first.');
  }
  if (!existsSync(join(ROOT, 'server', 'dist', 'index.js'))) {
    throw new Error('server/dist/index.js is missing — run `npm --prefix server run build` first.');
  }

  const puppeteer = loadPuppeteer();
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

  const signaling = spawn('node', [join(ROOT, 'server', 'dist', 'index.js')], {
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      PORT: String(SIGNALING_PORT),
      HOST: '127.0.0.1',
      NODE_ENV: 'production',
      LOG_LEVEL: 'warn',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(signaling);
  signaling.stdout.on('data', (chunk) => process.env.E2E_VERBOSE && process.stdout.write(`  [signal] ${chunk}`));
  signaling.stderr.on('data', (chunk) => process.env.E2E_VERBOSE && process.stderr.write(`  [signal] ${chunk}`));

  const preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort', '--host', '127.0.0.1'], {
    detached: process.platform !== 'win32',
    cwd: ROOT,
    env: { ...process.env, SIGNALING_PROXY_TARGET: `http://127.0.0.1:${SIGNALING_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(preview);
  preview.stdout.on('data', (chunk) => process.env.E2E_VERBOSE && process.stdout.write(`  [preview] ${chunk}`));
  preview.stderr.on('data', (chunk) => process.env.E2E_VERBOSE && process.stderr.write(`  [preview] ${chunk}`));

  await waitForHttp(`http://127.0.0.1:${SIGNALING_PORT}/health`);
  await waitForHttp(BASE_URL);
  console.log(`  signaling: http://127.0.0.1:${SIGNALING_PORT}   frontend: ${BASE_URL}`);

  // Chrome insists on a download directory; keep it in a throwaway folder instead of
  // letting it initialise the default `~/Downloads`.
  const scratchDir = mkdtempSync(join(tmpdir(), 'lanshare-reconnect-'));
  // Chromium creates its default `~/Downloads` on launch even with `downloadsPath` set;
  // remember whether it was already there so this run can remove it again if it was not.
  const defaultDownloadsDir = join(homedir(), 'Downloads');
  const defaultDownloadsExisted = existsSync(defaultDownloadsDir);
  const browser = await puppeteer.launch({
    headless: true,
    downloadsPath: scratchDir,
    protocolTimeout: 45_000,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const contextA = await browser.createBrowserContext();
      const contextB = await browser.createBrowserContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const close = async () => {
        await pageA.close().catch(() => undefined);
        await pageB.close().catch(() => undefined);
        await contextA.close().catch(() => undefined);
        await contextB.close().catch(() => undefined);
      };

      await Promise.all([
        pageA.goto(`${BASE_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
        pageB.goto(`${BASE_URL}?debug=1`, { waitUntil: 'domcontentloaded' }),
      ]);
      await Promise.all([dismissOnboarding(pageA), dismissOnboarding(pageB)]);

      // Page A must be the non-dialer (a larger id) both before and after its reload, so
      // the survivor (B) stays the dialer and keeps the link that dies with A's page.
      const ids = await waitFor(
        async () => {
          const stateA = await snapshot(pageA);
          const stateB = await snapshot(pageB);
          if (!stateA?.selfId || !stateB?.selfId) return null;
          return { stateA, stateB };
        },
        20_000,
        'both session ids',
      );
      if (!ids || !(ids.stateA.selfId > ids.stateB.selfId) || !isConnected(ids.stateA) || !isConnected(ids.stateB)) {
        const connected = ids ? `${isConnected(ids.stateA)}/${isConnected(ids.stateB)}` : 'n/a';
        console.log(
          `  attempt ${attempt}: A=${ids?.stateA?.selfId ?? '?'} B=${ids?.stateB?.selfId ?? '?'} connected=${connected} — not the dialer ordering we need, redrawing`,
        );
        await close();
        continue;
      }

      console.log(`  attempt ${attempt}: A=${ids.stateA.selfId} (non-dialer) B=${ids.stateB.selfId} (dialer) — connected, reloading A while offline for ${(OFFLINE_DWELL_MS / 1000).toFixed(0)} s`);
      const reloadStartedAt = Date.now();
      // Watch the link come back while the page re-joins, so the intermediate (dead)
      // states are part of the evidence rather than a single final observation.
      const observed = [];
      const sampling = (async () => {
        for (let i = 0; i < 24; i += 1) {
          const state = await snapshot(pageA);
          if (state?.selfId) {
            const text = linkText(state);
            if (observed[observed.length - 1] !== text) observed.push(text);
          }
          await sleep(250);
        }
      })();
      await pageA.setOfflineMode(true);
      try {
        await pageA.reload({ waitUntil: 'domcontentloaded' });
        // Hold the page offline while the survivor tears down its dead link and offers into
        // the void, then let it come back — the offer it already sent is unrecoverable.
        await sleep(OFFLINE_DWELL_MS);
      } finally {
        await pageA.setOfflineMode(false);
      }

      const after = await waitFor(
        async () => {
          const stateA = await snapshot(pageA);
          const stateB = await snapshot(pageB);
          if (!stateA?.selfId || !stateB?.selfId) return null;
          return { stateA, stateB };
        },
        20_000,
        "A's new session id after the reload",
      );
      if (!after) {
        await close();
        continue;
      }
      if (!(after.stateA.selfId > after.stateB.selfId)) {
        console.log(`  attempt ${attempt}: reloaded A=${after.stateA.selfId} became the dialer — redrawing for the hard ordering`);
        await close();
        continue;
      }

      console.log(`  attempt ${attempt}: reloaded A=${after.stateA.selfId}, survivor B=${after.stateB.selfId} keeps the dialer link`);
      console.log(`    survivor B ${linkText(after.stateB)}`);

      const recovered = await waitFor(async () => (isConnected(await snapshot(pageA)) ? true : null), RECOVERY_TIMEOUT_MS, 'the link to be rebuilt');
      const finalA = await snapshot(pageA);
      const finalB = await snapshot(pageB);
      const seconds = ((Date.now() - reloadStartedAt) / 1000).toFixed(1);
      await sampling;
      console.log(`    seen on A: ${observed.join('  →  ') || '<no snapshot>'}`);
      console.log(`    final A ${linkText(finalA)}`);
      console.log(`          B ${linkText(finalB)}`);

      if (!recovered) {
        console.error(`\n  ✗ reconnect regression: the link was not rebuilt within ${RECOVERY_TIMEOUT_MS} ms`);
        process.exitCode = 1;
      } else {
        console.log(`\n  ✓ reconnect recovered on its own ${seconds} s after the reload (dialer rebuilt the link, no reload or retry on B)`);
        console.log(`\nReconnect result: 1/1 check passed`);
      }
      await browser.close();
      cleanup();
      return;
    }

    console.error(`\n  ✗ could not draw the required dialer ordering within ${MAX_ATTEMPTS} attempts`);
    process.exitCode = 1;
  } finally {
    await browser.close().catch(() => undefined);
    cleanup();
    rmSync(scratchDir, { recursive: true, force: true });
    if (!defaultDownloadsExisted) {
      try {
        // Only removes an empty directory that this run created.
        rmdirSync(defaultDownloadsDir);
      } catch {
        /* not empty or already gone — leave it alone */
      }
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error) => {
    console.error(`\nReconnect test failed: ${error?.stack ?? error}`);
    process.exit(1);
  });
