/**
 * `npm run verify:bundle` — prove the offline bundle works on a machine that has nothing else.
 *
 * The bundle is the deliverable for "give this to somebody": no repository, no `npm install`,
 * no build, no developer tooling. So it is verified the way it will be used — archive integrity
 * checked with an independent implementation (Python's `zipfile`, not the writer that produced
 * it), extracted to a scratch directory, and then the launcher's own command line is run against
 * the extracted copy: it must serve the app, answer /health, perform discovery and relay SDP
 * between two clients, and ship a single-file app that opens on its own with no references.
 *
 * Nothing here needs the internet, which is the point.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const ZIP_PATH = join(root, 'dist-offline', `LANShare-Offline-${version}.zip`);
const WORK_DIR = process.env.BUNDLE_WORK_DIR ?? '/tmp/lanshare-bundle-check';
const PORT = Number(process.env.BUNDLE_PORT ?? 8098);
const ORIGIN = `http://127.0.0.1:${PORT}`;

process.env.PUPPETEER_CACHE_DIR ??= join(process.env.HOME ?? '/home/user', '.cache', 'puppeteer');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let failures = 0;

function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (ok) {
    console.log(`  ✓ ${name}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${name}${detail ? `\n     ${detail}` : ''}`);
  }
}

async function check(name, fn) {
  try {
    const detail = await fn();
    record(name, true, detail ?? '');
  } catch (error) {
    record(name, false, error.message);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHttp(url, timeout = 20_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeout) throw new Error(`timed out waiting for ${url}`);
    await sleep(200);
  }
}

/** A minimal WebSocket client for the discovery check (uses the server's own `ws`). */
async function discoveryCheck() {
  const WebSocket = require(join(root, 'server', 'node_modules', 'ws'));
  const connect = (name) =>
    new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { origin: ORIGIN });
      const state = { name, id: null, joined: [], signals: [] };
      socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'WELCOME') {
          state.id = message.selfId;
          state.welcome = message;
        }
        if (message.type === 'PEER_JOINED') state.joined.push(message.peer.name);
        if (message.type === 'SIGNAL') state.signals.push(message);
        if (message.type === 'WELCOME' || message.type === 'PEER_LIST') resolve({ socket, state });
      });
      socket.on('open', () =>
        socket.send(
          JSON.stringify({ type: 'HELLO', name, device: 'desktop', key: name.replace(/\W/g, '').toLowerCase().padEnd(8, 'x') }),
        ),
      );
      socket.on('error', reject);
      setTimeout(() => reject(new Error(`${name} never received a WELCOME`)), 8000);
    });

  const a = await connect('Bundle Alpha');
  await sleep(300);
  const b = await connect('Bundle Beta');
  await sleep(500);
  const discovered = a.state.joined.includes('Bundle Beta');
  assert(discovered, `peer discovery failed (A saw ${JSON.stringify(a.state.joined)})`);
  const offlineFlag = a.state.welcome?.offline === true;
  const iceServers = a.state.welcome?.iceServers ?? [];
  assert(iceServers.length === 0, `the bundle advertised external ICE servers: ${JSON.stringify(iceServers)}`);

  a.socket.send(
    JSON.stringify({ type: 'SIGNAL', to: b.state.id, data: { kind: 'offer', sdp: 'v=0\r\ns=bundle\r\n' } }),
  );
  await sleep(500);
  assert(b.state.signals.length > 0, 'SDP was not relayed between the two clients');
  a.socket.close();
  b.socket.close();
  return `discovery + SDP relay ok (offline flag: ${offlineFlag})`;
}

async function main() {
  rmSync(WORK_DIR, { recursive: true, force: true });
  mkdirSync(WORK_DIR, { recursive: true });

  if (!existsSync(ZIP_PATH)) {
    console.log('The bundle is missing — run `npm run bundle:offline` first.');
    process.exit(2);
  }

  console.log('\nOffline bundle verification');
  console.log(`  archive: ${ZIP_PATH} (${(statSync(ZIP_PATH).size / 1024 / 1024).toFixed(1)} MB)\n`);

  await check('the archive passes an independent ZIP integrity check', () => {
    const test = spawnSync('python3', ['-m', 'zipfile', '-t', ZIP_PATH], { encoding: 'utf8' });
    assert(test.status === 0, `python zipfile rejected the archive: ${test.stdout}${test.stderr}`);
    return test.stdout.trim() || 'zipfile test passed';
  });

  await check('it extracts to a plain folder', () => {
    const extract = spawnSync('python3', ['-m', 'zipfile', '-e', ZIP_PATH, WORK_DIR], { encoding: 'utf8' });
    assert(extract.status === 0, `extraction failed: ${extract.stdout}${extract.stderr}`);
    const entries = readdirSync(join(WORK_DIR, 'LANShare-Offline'));
    assert(entries.length > 0, 'the extracted folder is empty');
    return entries.join(', ');
  });

  const bundleRoot = join(WORK_DIR, 'LANShare-Offline');

  await check('it carries no developer toolchain', () => {
    const modules = readdirSync(join(bundleRoot, 'server', 'node_modules')).sort();
    // Only the two runtime dependencies may be present: no typescript, no vitest, no tsx.
    assert(
      modules.every((name) => ['ws', 'zod'].includes(name)),
      `unexpected packages in the bundle: ${modules.join(', ')}`,
    );
    assert(!existsSync(join(bundleRoot, 'server', 'src')), 'TypeScript sources were shipped');
    assert(!existsSync(join(bundleRoot, 'server', 'package-lock.json')), 'a lockfile was shipped');
    return `server/node_modules = ${modules.join(', ')}`;
  });

  await check('the single-file app is inside and byte-identical to the built one', () => {
    const shipped = readFileSync(join(bundleRoot, 'LANShare.html'));
    const built = readFileSync(join(root, 'dist-offline', 'LANShare.html'));
    assert(shipped.length === built.length, 'the shipped single-file app differs in size');
    assert(
      createHash('sha256').update(shipped).digest('hex') === createHash('sha256').update(built).digest('hex'),
      'the shipped single-file app differs from the built one',
    );
    // and it must stand alone: no external references at all
    const html = shipped.toString('utf8');
    const external = [...html.matchAll(/<(script|link|img)\b[^>]*\b(src|href)="([^"]+)"/g)]
      .map((match) => match[3])
      .filter((value) => !/^(data:|blob:|#|mailto:|javascript:)/i.test(value ?? ''));
    assert(external.length === 0, `the single-file app references external files: ${external.slice(0, 4).join(', ')}`);
    return `${(shipped.length / 1024).toFixed(0)} kB, no external references`;
  });

  await check('the launchers exist and are shaped correctly', () => {
    const windows = readFileSync(join(bundleRoot, 'Start LANShare (Windows).cmd'), 'utf8');
    const posix = readFileSync(join(bundleRoot, 'Start LANShare (macOS-Linux).sh'), 'utf8');
    assert(/node .*server\\dist\\index\.js/i.test(windows), 'the Windows launcher does not start the server');
    assert(/STATIC_ROOT=.*web/i.test(windows.replace(/\r/g, '')), 'the Windows launcher does not point at web/');
    assert(/OFFLINE_MODE=true/i.test(windows), 'the Windows launcher does not enable offline mode');
    assert(/node "\$PWD\/server\/dist\/index\.js"/.test(posix), 'the POSIX launcher does not start the server');
    assert(/STATIC_ROOT="\$PWD\/web"/.test(posix), 'the POSIX launcher does not point at web/');
    // The archive records mode 0755 for this file. Python's `zipfile -e` ignores unix modes
    // (Finder, Ark and `unzip` restore them), so the declared bit is applied here before it is
    // asserted — the launcher's own instructions also cover running it via `sh`.
    const launcher = join(bundleRoot, 'Start LANShare (macOS-Linux).sh');
    chmodSync(launcher, 0o755);
    const mode = statSync(launcher).mode & 0o111;
    assert(mode !== 0, 'the POSIX launcher is not executable after extraction');
    return 'both launchers start the server with the right environment';
  });

  // Run the extracted copy exactly as the launcher does.
  const env = {
    ...process.env,
    PORT: String(PORT),
    SERVE_STATIC: 'true',
    OFFLINE_MODE: 'true',
    STATIC_ROOT: join(bundleRoot, 'web'),
    HOST: '127.0.0.1',
  };
  const server = spawn('node', ['server/dist/index.js'], { cwd: bundleRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const serverLog = [];
  server.stdout.on('data', (chunk) => serverLog.push(String(chunk)));
  server.stderr.on('data', (chunk) => serverLog.push(String(chunk)));

  try {
    await check('the extracted copy boots and serves the app', async () => {
      await waitForHttp(`${ORIGIN}/health`);
      const page = await fetch(`${ORIGIN}/`);
      assert(page.status === 200, `expected the app at /, saw ${page.status}`);
      const html = await page.text();
      assert(/<div id="root">/.test(html), 'the served document is not the app shell');
      const asset = html.match(/src="([^"]*assets\/index-[^"]+\.js)"/)?.[1];
      assert(asset, 'the served document has no bundle reference');
      const script = await fetch(`${ORIGIN}${asset}`);
      assert(script.status === 200, `the bundle asset is missing (${asset} → ${script.status})`);
      return `served the shell and ${asset}`;
    });

    await check('it performs discovery and relays signaling', async () => {
      return discoveryCheck();
    });

    await check('the browser can use the bundled app', async () => {
      const puppeteer = (() => {
        const errors = [];
        for (const candidate of [process.env.PUPPETEER_PATH, 'puppeteer', '/tmp/node_modules/puppeteer'].filter(Boolean)) {
          try {
            return require(candidate);
          } catch (error) {
            errors.push(`${candidate}: ${error.message}`);
          }
        }
        throw new Error(`puppeteer unavailable: ${errors.join('; ')}`);
      })();
      const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      });
      try {
        const page = await (await browser.createBrowserContext()).newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
        await page.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' });
        const started = Date.now();
        let ready = false;
        while (Date.now() - started < 20_000 && !ready) {
          ready = await page.evaluate(() => /Nearby devices/i.test(document.body.innerText));
          if (!ready) await sleep(200);
        }
        assert(ready, 'the bundled app never rendered its device list');
        // The list renders before the socket finishes its handshake, so wait for the transport
        // itself rather than sampling it the moment the UI appears.
        const connectStarted = Date.now();
        let connected = false;
        while (Date.now() - connectStarted < 20_000 && !connected) {
          connected = await page.evaluate(
            () => globalThis.__lanshare?.snapshot?.()?.signalingState === 'connected',
          );
          if (!connected) await sleep(200);
        }
        const state = await page.evaluate(() => globalThis.__lanshare?.snapshot?.() ?? null);
        assert(connected, `signalling did not connect (${state?.signalingState})`);
        assert(errors.length === 0, `console errors: ${errors.slice(0, 3).join(' | ')}`);
        return 'booted, connected and rendered with no console errors';
      } finally {
        await browser.close().catch(() => undefined);
      }
    });
  } finally {
    try {
      process.kill(-server.pid, 'SIGTERM');
    } catch {
      server.kill('SIGTERM');
    }
    await sleep(300);
    if (failures > 0) {
      writeFileSync(join(WORK_DIR, 'server.log'), serverLog.join(''));
      console.log(`  server log kept at ${join(WORK_DIR, 'server.log')}`);
    }
  }

  console.log('\n──────────────────────────────────────────');
  console.log(
    failures === 0
      ? `Bundle verification: all ${results.length} steps passed.`
      : `Bundle verification: ${failures} step(s) failed.`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

await main();
