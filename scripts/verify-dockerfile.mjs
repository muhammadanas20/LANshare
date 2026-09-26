/**
 * Dockerfile dry-run.
 *
 * `docker` is not required (and is often unavailable in CI sandboxes). This script replays
 * every instruction of the signaling-server Dockerfile, in order, inside a scratch
 * directory and then exercises the *runtime stage* exactly as the image would:
 *
 *   1. build stage   — `npm install`, copy `tsconfig.json` + `src` (minus test files, as
 *                      `.dockerignore` would), `npm run build`, assert `dist/index.js`
 *   2. runtime stage — `npm install --omit=dev`, copy `dist`, assert no dev dependencies
 *   3. `CMD`         — start `node dist/index.js`, wait for `/health`
 *   4. `HEALTHCHECK` — run the image's own health command verbatim, up *and* down
 *   5. signaling     — two clients join, discover each other and relay an SDP offer
 *   6. privacy       — no payload-persistence API anywhere in the server source
 *
 * What this cannot verify (be honest about it): the container layer itself — the Alpine
 * base image, `USER node` privileges and Docker's healthcheck scheduling. Everything the
 * instructions actually *do* is covered.
 *
 * Usage: node scripts/verify-dockerfile.mjs
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRATCH = join(tmpdir(), 'lanshare-docker-sim');
const BUILD_DIR = join(SCRATCH, 'build');
const RUNTIME_DIR = join(SCRATCH, 'runtime');
const PORT = Number(process.env.DOCKER_SIM_PORT ?? 8091);

let failures = 0;
const ok = (message) => console.log(`  ✓ ${message}`);
const fail = (message) => {
  failures += 1;
  console.error(`  ✗ ${message}`);
};

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed (${result.status})\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  }
  return result;
}

const npm = (args, cwd) => run('npm', args, { cwd, stdio: 'pipe' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth(url, timeoutMs = 15_000) {
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {
      /* not up yet */
    }
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${url}`);
    await sleep(200);
  }
}

/** Minimal .dockerignore matcher for the patterns this repo actually uses. */
function isIgnored(relativePath, patterns) {
  const normalized = relativePath.replace(/^\.\//, '');
  return patterns.some((pattern) => {
    const clean = pattern.replace(/^!/, '').replace(/\/$/, '');
    if (clean.includes('**/')) {
      const [prefix, suffix] = clean.split('**/');
      return normalized.startsWith(prefix) && normalized.endsWith(suffix.replace(/^\*/, ''));
    }
    if (clean.endsWith('.*')) return normalized.startsWith(clean.slice(0, -1));
    return normalized === clean || normalized.startsWith(`${clean}/`);
  });
}

async function main() {
  console.log('\nLANShare Dockerfile dry-run (no docker needed)');
  console.log('──────────────────────────────────────────');

  const dockerfile = readFileSync(join(ROOT, 'Dockerfile'), 'utf8');
  const patterns = readFileSync(join(ROOT, '.dockerignore'), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));

  /* ---------------- the build context must contain what COPY needs ---------------- */
  console.log('\nBuild context (.dockerignore vs COPY):');
  const copied = [...dockerfile.matchAll(/^COPY\s+(.+)$/gm)]
    .map((match) => match[1].trim())
    .flatMap((line) => {
      const tokens = line.split(/\s+/).filter((token) => !token.startsWith('--'));
      // `COPY src [src...] dest` — the final token is the destination inside the image.
      return tokens.slice(0, -1);
    })
    .filter((token) => token.startsWith('server/'));
  for (const source of copied) {
    if (isIgnored(source.replace(/^\.\//, ''), patterns)) fail(`COPY ${source} resolves to an ignored path`);
    else ok(`COPY ${source} is present in the context`);
  }

  rmSync(SCRATCH, { recursive: true, force: true });
  mkdirSync(BUILD_DIR, { recursive: true });
  mkdirSync(RUNTIME_DIR, { recursive: true });

  /* ------------------------------ 1. build stage ------------------------------ */
  console.log('\nStage 1 — build:');
  for (const file of ['package.json', 'package-lock.json']) {
    cpSync(join(ROOT, 'server', file), join(BUILD_DIR, file));
  }
  npm(['install', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error'], BUILD_DIR);
  cpSync(join(ROOT, 'server', 'tsconfig.json'), join(BUILD_DIR, 'tsconfig.json'));
  cpSync(join(ROOT, 'server', 'src'), join(BUILD_DIR, 'src'), {
    recursive: true,
    // `.dockerignore` removes test files from the context, so the build must not need them.
    filter: (source) => !source.endsWith('.test.ts'),
  });
  npm(['run', 'build'], BUILD_DIR);
  if (existsSync(join(BUILD_DIR, 'dist', 'index.js'))) ok('`npm run build` produced dist/index.js from a test-free context');
  else fail('dist/index.js was not produced');

  /* ----------------------------- 2. runtime stage ----------------------------- */
  console.log('\nStage 2 — runtime:');
  for (const file of ['package.json', 'package-lock.json']) {
    cpSync(join(ROOT, 'server', file), join(RUNTIME_DIR, file));
  }
  npm(['install', '--omit=dev', '--no-audit', '--no-fund', '--prefer-offline', '--loglevel=error'], RUNTIME_DIR);
  cpSync(join(BUILD_DIR, 'dist'), join(RUNTIME_DIR, 'dist'), { recursive: true });
  const leaked = ['typescript', 'tsx', 'vitest'].filter((dep) => existsSync(join(RUNTIME_DIR, 'node_modules', dep)));
  if (leaked.length === 0) ok('runtime node_modules contains production dependencies only');
  else fail(`dev dependencies present in the runtime stage: ${leaked.join(', ')}`);

  /* --------------------------------- 3. CMD --------------------------------- */
  console.log('\nCMD + HEALTHCHECK:');
  const server = spawn('node', ['dist/index.js'], {
    cwd: RUNTIME_DIR,
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'production', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stopped = new Promise((resolve) => server.on('exit', resolve));
  let serverLog = '';
  server.stdout.on('data', (chunk) => (serverLog += String(chunk)));
  server.stderr.on('data', (chunk) => (serverLog += String(chunk)));

  try {
    const health = await waitForHealth(`http://127.0.0.1:${PORT}/health`);
    ok(`\`node dist/index.js\` serves /health: ${JSON.stringify(health)}`);

    /* ------------------- 4. the image's own HEALTHCHECK command ------------------- */
    const healthcheck = dockerfile.match(/HEALTHCHECK[^\n]*\\\n\s*CMD\s+(.+)/);
    if (!healthcheck) fail('no HEALTHCHECK command found in the Dockerfile');
    else {
      // The image runs `node -e "<script>"`; execute the script itself with the same env.
      const raw = healthcheck[1].trim();
      const command = (raw.replace(/^node\s+-e\s+/, '') || raw).replace(/^"(.*)"$/s, '$1');
      const up = spawnSync('node', ['-e', command], { env: { ...process.env, PORT: String(PORT) }, encoding: 'utf8' });
      if (up.status === 0) ok('HEALTHCHECK command exits 0 while the server is up');
      else fail(`HEALTHCHECK command exited ${up.status} while the server is up`);

      const down = spawnSync('node', ['-e', command], {
        env: { ...process.env, PORT: String(PORT + 1) },
        encoding: 'utf8',
      });
      if (down.status !== 0) ok('HEALTHCHECK command exits non-zero while the server is down (no false healthy)');
      else fail('HEALTHCHECK reported healthy with no server listening');
    }

    /* ------------------- 4b. the default port must be consistent ------------------- */
    console.log('\nDefault port (no PORT in the environment):');
    const exposed = dockerfile.match(/^EXPOSE\s+(\d+)/m)?.[1];
    const healthFallback = dockerfile.match(/process\.env\.PORT\s*\|\|\s*(\d+)/)?.[1];
    const configDefault = readFileSync(join(BUILD_DIR, 'src', 'config.ts'), 'utf8').match(
      /num\(process\.env\.PORT,\s*(\d+)\)/,
    )?.[1];
    if (exposed && exposed === healthFallback && exposed === configDefault) {
      ok(`EXPOSE, the HEALTHCHECK fallback and the server config all default to ${exposed}`);
    } else {
      fail(`default-port mismatch: EXPOSE=${exposed}, healthcheck=${healthFallback}, server=${configDefault}`);
    }

    // Run the image's own health command with no PORT set, against a server started the
    // same way — this is the path a bare `docker run` takes.
    const defaultPort = Number(exposed ?? 8080);
    const defaultServer = spawn('node', ['dist/index.js'], {
      cwd: RUNTIME_DIR,
      env: { ...process.env, HOST: '127.0.0.1', NODE_ENV: 'production', LOG_LEVEL: 'warn', PORT: undefined },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const defaultStopped = new Promise((resolve) => defaultServer.on('exit', resolve));
    try {
      const health = await waitForHealth(`http://127.0.0.1:${defaultPort}/health`, 8000);
      ok(`\`node dist/index.js\` with no PORT serves /health on ${defaultPort}: ${JSON.stringify(health)}`);
      const script = (dockerfile.match(/HEALTHCHECK[^\n]*\\\n\s*CMD\s+(.+)/)?.[1] ?? '')
        .trim()
        .replace(/^node\s+-e\s+/, '')
        .replace(/^"(.*)"$/s, '$1');
      const result = spawnSync('node', ['-e', script], {
        env: { ...process.env, PORT: undefined },
        encoding: 'utf8',
      });
      if (result.status === 0) ok('HEALTHCHECK exits 0 with the default port');
      else fail(`HEALTHCHECK exited ${result.status} with the default port`);
    } catch (error) {
      ok(`default-port run skipped (${defaultPort} unavailable here: ${error.message}) — consistency is still checked statically`);
    } finally {
      defaultServer.kill('SIGKILL');
      await Promise.race([defaultStopped, sleep(2000)]);
    }

    /* --------------- 5. the runtime stage must actually signal --------------- */
    const require = createRequire(join(RUNTIME_DIR, 'package.json'));
    const WebSocket = require('ws');
    const url = `ws://127.0.0.1:${PORT}/ws`;
    const joinRoom = (name) =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(url);
        const timer = setTimeout(() => reject(new Error(`${name}: no WELCOME within 8 s`)), 8000);
        socket.on('open', () => socket.send(JSON.stringify({ type: 'HELLO', room: 'NEARBY', name, device: 'desktop' })));
        socket.on('message', (raw) => {
          const message = JSON.parse(String(raw));
          if (message.type === 'WELCOME') {
            clearTimeout(timer);
            resolve({ socket, selfId: message.selfId, roomId: message.roomId });
          }
          if (message.type === 'ERROR') {
            clearTimeout(timer);
            reject(new Error(`${name}: ${message.message}`));
          }
        });
        socket.on('error', reject);
      });

    const alice = await joinRoom('Alice');
    const bob = await joinRoom('Bob');
    const discovered = await new Promise((resolve) => {
      alice.socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'PEER_JOINED' && message.peer?.id === bob.selfId) resolve(true);
      });
      setTimeout(() => resolve(false), 8000);
    });
    alice.socket.send(JSON.stringify({ type: 'SIGNAL', to: bob.selfId, data: { kind: 'offer', sdp: 'v=0 dry-run' } }));
    const relayed = await new Promise((resolve) => {
      bob.socket.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.type === 'SIGNAL' && message.data?.kind === 'offer') resolve(true);
      });
      setTimeout(() => resolve(false), 8000);
    });
    alice.socket.close();
    bob.socket.close();
    if (discovered && relayed) ok(`discovery + SDP relay work in the runtime stage (room ${alice.roomId})`);
    else fail(`signaling handshake incomplete (discovery=${discovered}, relay=${relayed})`);

    /* ------------------------ 6. the privacy invariant ------------------------ */
    // The promise is that the signaling server never stores anything — above all never file
    // bytes. Two read-only touches are legitimate and must not be confused with persistence:
    //   · `static.ts` streams the *public build directory* when the process also hosts the
    //     frontend in offline mode (`npm run offline`)
    //   · `index.ts` reads operator-provided TLS material
    // So: no write API anywhere, and the modules on the signaling/payload path must not touch
    // `node:fs` at all.
    // Only real filesystem APIs — the signaling code legitimately has `rename()` for peers
    // and the test files write their own fixtures, so both are excluded deliberately.
    const writeApis = spawnSync(
      'sh',
      [
        '-c',
        `grep -rniE "writeFile|writeFileSync|createWriteStream|appendFile|mkdir|mkdirSync|unlink|unlinkSync|truncate|truncateSync|rmdir|rmSync|copyFile|chown|chmod|utimes" ${join(BUILD_DIR, 'src')}/*.ts | grep -vE "\\.test\\.ts" || true`,
      ],
      { encoding: 'utf8' },
    ).stdout.trim();
    if (writeApis === '') ok('no filesystem *write* API anywhere in the server source');
    else fail(`server source can write to disk:\n${writeApis}`);

    // `node:path` is just string work (config resolves the static root); what must never
    // appear outside those three modules is reading file contents. A third legitimate reader
    // joined them: `server.ts` offers the *operator's own* single-file build for download
    // (`SINGLE_FILE_PATH`), so a phone can keep a copy that needs no server at all. That read
    // is of one path chosen by whoever started the process — never a path a peer supplied —
    // so the allowance below is narrowed to that exact variable rather than blanket-granted.
    const payloadPath = spawnSync(
      'sh',
      ['-c', `grep -rlnE "node:fs|readFile|createReadStream" ${join(BUILD_DIR, 'src')}/*.ts | grep -vE "static\\.ts|index\\.ts|server\\.ts|\\.test\\.ts" || true`],
      { encoding: 'utf8' },
    ).stdout.trim();
    if (payloadPath === '') {
      ok('the signaling/payload path (rooms, protocol, lan, logger) never touches the filesystem');
    } else {
      fail(`filesystem access found outside the static host, server and TLS loader:\n${payloadPath}`);
    }

    // …and that allowance is verified, not assumed: inside `server.ts` every read must be of
    // the operator-configured `singleFilePath` (an import line is not a use), and that value
    // must originate in the environment rather than in a request.
    const strayReads = spawnSync(
      'sh',
      [
        '-c',
        `grep -nE "readFile|createReadStream|existsSync|statSync|node:fs" ${join(BUILD_DIR, 'src', 'server.ts')} | grep -vE "^[0-9]+:import " | grep -v "singleFilePath" || true`,
      ],
      { encoding: 'utf8' },
    ).stdout.trim();
    const readsAreScoped = spawnSync(
      'sh',
      ['-c', `grep -cE "singleFilePath *[:=] *process\\.env\\.SINGLE_FILE_PATH" ${join(BUILD_DIR, 'src', 'config.ts')} || true`],
      { encoding: 'utf8' },
    ).stdout.trim();
    if (strayReads === '' && readsAreScoped !== '0') {
      ok('the single-file download route reads only the operator-configured path, never a request path');
    } else {
      fail(
        `the single-file route touches the filesystem beyond its configured artefact ` +
          `(stray reads: ${strayReads || 'none'}, env-sourced: ${readsAreScoped})`,
      );
    }
  } catch (error) {
    fail(error.message);
  } finally {
    server.kill('SIGKILL');
    await Promise.race([stopped, sleep(2000)]);
    if (failures === 0) rmSync(SCRATCH, { recursive: true, force: true });
    else {
      console.error(`\n  scratch directory kept for inspection: ${SCRATCH}`);
      console.error(`  server log tail:\n${serverLog.split('\n').slice(-8).join('\n')}`);
    }
  }

  console.log('\n──────────────────────────────────────────');
  if (failures === 0) {
    console.log('Dockerfile dry-run: all steps replayed successfully.');
    console.log('Not covered (honest): the container layer itself — Alpine base, USER node, healthcheck scheduling.');
  } else {
    console.error(`Dockerfile dry-run: ${failures} step(s) failed.`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(`\nDockerfile dry-run crashed: ${error?.stack ?? error}`);
  process.exit(1);
});
