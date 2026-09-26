/**
 * `npm run offline` — LANShare on a network with no internet.
 *
 * One process, one port: it serves the built frontend *and* the WebRTC signaling WebSocket,
 * advertises no external STUN servers, and prints the address every other device on the LAN
 * should open. Nothing here needs the internet — the only prerequisite is that the devices
 * can reach each other (same Wi-Fi, a phone hotspot, or a cable).
 *
 * Flags:
 *   --port=8080   port to listen on (default 8080)
 *   --secure      serve HTTPS using server/.certs (run `npm run cert` first); required only
 *                 to install the app as a PWA on a phone, since service workers need HTTPS
 *   --no-build    fail instead of building when dist/ is missing
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const port = Number(args.find((a) => a.startsWith('--port='))?.split('=')[1] ?? process.env.PORT ?? 8080);
const secure = args.includes('--secure');
const allowBuild = !args.includes('--no-build');

const CERT_DIR = join(root, 'server', '.certs');
const CERT = join(CERT_DIR, 'cert.pem');
const KEY = join(CERT_DIR, 'key.pem');

function lanAddresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return [...new Set(found)].sort();
}

function run(command, commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', ...options });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`))));
    child.on('error', reject);
  });
}

const distIndex = join(root, 'dist', 'index.html');
if (!existsSync(distIndex)) {
  if (!allowBuild) {
    console.error('dist/ is missing. Run `npm run build` first (or drop --no-build).');
    process.exit(1);
  }
  console.log('Building the frontend first (dist/ is missing)…\n');
  await run('npm', ['run', 'build']);
}

if (secure) {
  if (!existsSync(CERT) || !existsSync(KEY)) {
    console.error(
      `No TLS material in ${CERT_DIR}.\nRun \`npm run cert\` first, or drop --secure to serve plain HTTP\n(transfers work over HTTP; only PWA installation needs HTTPS).`,
    );
    process.exit(1);
  }
}

const scheme = secure ? 'https' : 'http';
const addresses = lanAddresses();
const host = (await import('node:os')).hostname().split('.')[0];

console.log('');
console.log('  LANShare — offline mode');
console.log('  ─────────────────────────────────────────────────────────');
console.log('  No internet needed. Devices only have to reach each other.');
console.log('');
if (addresses.length === 0) {
  console.log('  No LAN address found — connect to a network first.');
} else {
  for (const address of addresses) {
    console.log(`  Open on your phone or another computer:  ${scheme}://${address}:${port}`);
  }
  console.log(`  (mDNS name, when the network supports it:  ${scheme}://${host}.local:${port})`);
}
console.log('');
console.log('  Phone → PC:  turn on the phone hotspot, join it from this computer,');
console.log('               then open the address above on the phone.');
console.log('  PC → PC:     both computers on the same router/Wi-Fi is enough.');
console.log('  Find each other:  1. run this command   2. open the address on both devices');
console.log('                    3. the other device appears in “Nearby devices”   4. send.');
console.log('  ─────────────────────────────────────────────────────────');
if (!secure) {
  console.log('  Note: served over HTTP. Transfers and the data channel work normally,');
  console.log('  but “install as app” needs HTTPS — run `npm run cert` then --secure.');
}
console.log('  Ctrl+C stops the server.\n');

const singleFile = join(root, 'dist-offline', 'LANShare.html');
const env = {
  ...process.env,
  PORT: String(port),
  SERVE_STATIC: 'true',
  STATIC_ROOT: join(root, 'dist'),
  OFFLINE_MODE: 'true',
  // Offered at /LANShare.html so a phone can save a copy that works with no server at all.
  SINGLE_FILE_PATH: existsSync(singleFile) ? singleFile : '',
  SIGNALING_PROXY_TARGET: '',
  ...(secure ? { TLS_CERT: CERT, TLS_KEY: KEY } : { TLS_CERT: '', TLS_KEY: '' }),
};

const child = spawn('npx', ['tsx', 'src/index.ts'], {
  cwd: join(root, 'server'),
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  detached: process.platform !== 'win32',
});

const stop = () => {
  try {
    if (process.platform === 'win32') child.kill('SIGTERM');
    else process.kill(-child.pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => process.exit(code ?? 0));

// Keep the config referenced so a mis-set env var is easy to spot in a bug report.
void readFileSync;
