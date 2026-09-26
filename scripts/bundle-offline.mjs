/**
 * `npm run bundle:offline` — build a folder someone can actually use.
 *
 * The point is to remove every prerequisite a normal person would trip over: no repository, no
 * `npm install`, no build step, no developer tools. The result is a single archive containing
 *
 *   LANShare.html            the whole app as ONE file — no server needed at all (open it and
 *                            pair two devices with a code; see README → single file)
 *   web/                     the served build, for the "run it on one computer" flow
 *   server/                  the compiled signaling + static server with only its two runtime
 *                            dependencies (ws, zod) — no dev toolchain
 *   Start LANShare.*         double-click launchers for Windows and macOS/Linux
 *   README-OFFLINE.txt       three steps, in plain language
 *
 * Node.js is the only thing the receiving machine needs, and only for the served flow — the
 * single-file app needs nothing at all.
 *
 * The ZIP is written here rather than shelled out to `zip`, because this script runs on the
 * user's machine and Windows has no `zip` binary. Everything is dependency-free.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = join(root, 'dist-offline');
const STAGE_DIR = join(OUT_DIR, 'bundle');
const WEB_DIR = join(STAGE_DIR, 'web');
const SERVER_DIR = join(STAGE_DIR, 'server');
const SINGLE_FILE = join(OUT_DIR, 'LANShare.html');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const ZIP_PATH = join(OUT_DIR, `LANShare-Offline-${version}.zip`);

/* ------------------------------------------------------------------ *
 * Minimal ZIP writer (deflate + a real central directory)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[index]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

/** DOS date/time, as the format requires (local time is fine for a build artifact). */
function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = date.getDate();
  const month = date.getMonth() + 1;
  const year = Math.max(0, date.getFullYear() - 1980);
  return { time, date: (year << 9) | (month << 5) | day };
}

class ZipWriter {
  constructor() {
    this.entries = [];
    this.chunks = [];
    this.offset = 0;
  }

  /** `mode` sets the unix permission bits so shell scripts stay executable after extraction. */
  add(path, data, { mode = 0o644 } = {}) {
    const nameBuffer = Buffer.from(path, 'utf8');
    const content = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const compressed = deflateRawSync(content, { level: 9 });
    const useDeflate = compressed.length < content.length;
    const payload = useDeflate ? compressed : content;
    const method = useDeflate ? 8 : 0;
    const checksum = crc32(content);
    const { time, date } = dosDateTime();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);

    this.chunks.push(local, nameBuffer, payload);
    this.entries.push({
      name: nameBuffer,
      method,
      time,
      date,
      checksum,
      compressedSize: payload.length,
      size: content.length,
      offset: this.offset,
      mode,
    });
    this.offset += local.length + nameBuffer.length + payload.length;
  }

  /** Recursively add a directory. `prefix` is the path inside the archive. */
  addDirectory(path, prefix, options = {}) {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const inside = prefix ? `${prefix}/${name}` : name;
      if (statSync(child).isDirectory()) {
        this.addDirectory(child, inside, options);
        continue;
      }
      if (options.skip?.(child, inside)) continue;
      this.add(inside, readFileSync(child), { mode: statSync(child).mode & 0o777 });
    }
  }

  finish() {
    const centralChunks = [];
    let centralSize = 0;
    for (const entry of this.entries) {
      const header = Buffer.alloc(46);
      header.writeUInt32LE(0x02014b50, 0);
      header.writeUInt16LE((3 << 8) | 20, 4); // made by unix, version 20
      header.writeUInt16LE(20, 6);
      header.writeUInt16LE(0x0800, 8);
      header.writeUInt16LE(entry.method, 10);
      header.writeUInt16LE(entry.time, 12);
      header.writeUInt16LE(entry.date, 14);
      header.writeUInt32LE(entry.checksum, 16);
      header.writeUInt32LE(entry.compressedSize, 20);
      header.writeUInt32LE(entry.size, 24);
      header.writeUInt16LE(entry.name.length, 28);
      header.writeUInt16LE(0, 30); // extra
      header.writeUInt16LE(0, 32); // comment
      header.writeUInt16LE(0, 34); // disk
      header.writeUInt16LE(0, 36); // internal attrs
      header.writeUInt32LE((entry.mode & 0xffff) << 16, 38); // external attrs
      header.writeUInt32LE(entry.offset, 42);
      centralChunks.push(header, entry.name);
      centralSize += header.length + entry.name.length;
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(this.entries.length, 8);
    end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(centralSize, 12);
    end.writeUInt32LE(this.offset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...this.chunks, ...centralChunks, end]);
  }
}

/* ------------------------------------------------------------------ *
 * Bundle assembly
 * ------------------------------------------------------------------ */

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
}

function ensureBuilds() {
  if (!existsSync(join(root, 'dist', 'index.html'))) {
    console.log('Building the served app (dist/ is missing)…');
    run('npm', ['run', 'build']);
  }
  if (!existsSync(SINGLE_FILE)) {
    console.log('Building the single-file app (dist-offline/LANShare.html is missing)…');
    run('npm', ['run', 'build:single']);
  }
  if (!existsSync(join(root, 'server', 'dist', 'index.js'))) {
    console.log('Building the signaling server…');
    run('npm', ['--prefix', 'server', 'run', 'build']);
  }
}

/** Copy only the server's runtime dependencies (from the lockfile, so no install is needed). */
function copyServerRuntime() {
  const lock = JSON.parse(readFileSync(join(root, 'server', 'package-lock.json'), 'utf8'));
  const production = Object.entries(lock.packages)
    .filter(([path, info]) => path.startsWith('node_modules/') && !info.dev && !info.optional)
    .map(([path]) => path);
  for (const path of production) {
    const source = join(root, 'server', path);
    if (!existsSync(source)) throw new Error(`runtime dependency ${path} is not installed — run \`npm --prefix server ci\``);
    const target = join(SERVER_DIR, path);
    mkdirSync(dirname(target), { recursive: true });
    runCopyTree(source, target);
  }
  return production;
}

function runCopyTree(source, target) {
  mkdirSync(target, { recursive: true });
  for (const name of readdirSync(source)) {
    const from = join(source, name);
    const to = join(target, name);
    if (statSync(from).isDirectory()) runCopyTree(from, to);
    else copyFileSync(from, to);
  }
}

function launcherScripts() {
  const windows = `@echo off
rem LANShare — offline mode. Serves this folder to phones and computers on the same network.
setlocal
cd /d "%~dp0"
set "PORT=8080"
set "SERVE_STATIC=true"
set "OFFLINE_MODE=true"
set "STATIC_ROOT=%~dp0web"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is required for this mode: https://nodejs.org/
  echo   No internet needed to transfer files - LANShare only uses it to install Node once.
  echo   Without Node you can still use LANShare.html - open it on both devices and pair with a code.
  echo.
  pause
  exit /b 1
)

echo.
echo   LANShare is starting. This window must stay open while you send files.
echo   Open the address printed below on your phone or the other computer.
echo.
start "" http://localhost:%PORT%/
node "%~dp0server\\dist\\index.js"
echo.
echo   LANShare stopped.
pause
`;

  const posix = `#!/usr/bin/env sh
# LANShare — offline mode. Serves this folder to phones and computers on the same network.
cd "$(dirname "$0")" || exit 1

if ! command -v node >/dev/null 2>&1; then
  echo
  echo "  Node.js is required for this mode: https://nodejs.org/"
  echo "  No internet is needed to transfer files - LANShare only uses it to install Node once."
  echo "  Without Node you can still use LANShare.html: open it on both devices and pair with a code."
  echo
  exit 1
fi

PORT=8080 SERVE_STATIC=true OFFLINE_MODE=true STATIC_ROOT="$PWD/web" \\
  node "$PWD/server/dist/index.js" &
SERVER_PID=$!

sleep 2
if command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:8080/" >/dev/null 2>&1
elif command -v open >/dev/null 2>&1; then open "http://localhost:8080/" >/dev/null 2>&1
fi

wait $SERVER_PID
`;

  const readme = `LANShare — offline file sharing
================================
Built by Muhammad Anas · share anything. Nearby. Instantly.

You do not need the internet to send files with this folder. Pick the flow that fits:

A) ONE COMPUTER RUNS IT (easiest when a computer is available)
   1. Install Node.js once if it is not installed already (nodejs.org).
   2. Double-click "Start LANShare (Windows).cmd" or run "Start LANShare (macOS-Linux).sh".
   3. It prints an address like http://192.168.1.23:8080 and opens it here.
   4. On the other device (phone or computer) join the same Wi-Fi or this computer's
      hotspot, then open that address.
   5. Both devices appear in "Nearby devices". Pick one, choose files, send.
   No internet is used at any point: the files travel directly between the devices.

   (macOS/Linux note: if the .sh file is not executable, run it as:
      sh "Start LANShare (macOS-Linux).sh"   )

B) NO SERVER AT ALL (no Node, two phones, or a computer you cannot install on)
   1. Send LANShare.html to both devices - USB, AirDrop, email attachment, chat message.
   2. Open it on both (it is the whole app, one file).
   3. On one device: "Pair another device" -> "Pair with a code",
      and show the invite code to the other device.
   4. The other device pastes it and shows a reply code; paste that back.
   5. Both devices appear in "Nearby devices" and you can send files.
   Both devices must be on the same Wi-Fi or hotspot. Nothing is uploaded anywhere.

Notes
-----
- Nothing is stored on any server. During a transfer the bytes go directly from one device
  to the other, encrypted (WebRTC/DTLS).
- The two devices must be able to reach each other: same router, or a phone hotspot that the
  other device has joined. Some public/corporate networks block device-to-device connections.
- If your phone cannot reach the computer, check the computer's firewall allows Node.js and
  that both are on the same network.
- Installable app: opening the address over plain HTTP works for transfers. To install the
  app on a phone (service worker), serve it over HTTPS - that is what "npm run offline:secure"
  does in the repository version.
`;
  return { windows, posix, readme };
}

function main() {
  ensureBuilds();
  rmSync(STAGE_DIR, { recursive: true, force: true });
  mkdirSync(STAGE_DIR, { recursive: true });

  // Served build.
  mkdirSync(WEB_DIR, { recursive: true });
  runCopyTree(join(root, 'dist'), WEB_DIR);

  // Compiled server + runtime dependencies only.
  mkdirSync(SERVER_DIR, { recursive: true });
  runCopyTree(join(root, 'server', 'dist'), join(SERVER_DIR, 'dist'));
  copyFileSync(join(root, 'server', 'package.json'), join(SERVER_DIR, 'package.json'));
  const runtime = copyServerRuntime();

  // The single-file app, at the top level where a person will find it.
  copyFileSync(SINGLE_FILE, join(STAGE_DIR, 'LANShare.html'));

  const { windows, posix, readme } = launcherScripts();
  writeFileSync(join(STAGE_DIR, 'Start LANShare (Windows).cmd'), windows.replace(/\n/g, '\r\n'));
  writeFileSync(join(STAGE_DIR, 'Start LANShare (macOS-Linux).sh'), posix);
  writeFileSync(join(STAGE_DIR, 'README-OFFLINE.txt'), readme);

  // Archive it.
  const zip = new ZipWriter();
  zip.addDirectory(STAGE_DIR, 'LANShare-Offline', {
    // The lockfile is not needed to run; the docs live in README-OFFLINE.txt.
    skip: (_path, inside) => inside.endsWith('package-lock.json'),
  });
  const archive = zip.finish();
  writeFileSync(ZIP_PATH, archive);

  const size = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  console.log(`\nOffline bundle ready`);
  console.log(`  folder: ${STAGE_DIR}`);
  console.log(`  archive: ${ZIP_PATH} (${size(archive.length)})`);
  console.log(`  sha256: ${createHash('sha256').update(archive).digest('hex')}`);
  console.log(`  server runtime dependencies copied: ${runtime.join(', ')}`);
  console.log(`  contents:`);
  for (const name of readdirSync(STAGE_DIR).sort()) {
    const path = join(STAGE_DIR, name);
    const detail = statSync(path).isDirectory() ? '(directory)' : size(statSync(path).size);
    console.log(`    ${name} ${detail}`);
  }
}

main();
