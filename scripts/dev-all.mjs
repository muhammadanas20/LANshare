/**
 * `npm run start:all` — one command for local development.
 *
 *  1. starts the WebSocket signaling server (tsx watch)
 *  2. starts the Vite dev server, which proxies /ws to the signaling server
 *
 * Ctrl+C stops both. No extra dependencies: this is plain Node.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const signalingPort = process.env.PORT ?? '8080';
const devPort = process.env.VITE_PORT ?? '5173';

const children = [];
let shuttingDown = false;

function run(name, command, args, options) {
  const child = spawn(command, args, {
    cwd: root,
    env: { ...process.env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
    ...options,
  });

  const prefix = `[${name}] `;
  const forward = (stream, target) => {
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) {
        if (line.trim().length > 0) target.write(`${prefix}${line}\n`);
      }
    });
  };
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on('exit', (code) => {
    if (shuttingDown) return;
    console.log(`${prefix}exited with code ${code ?? 0}`);
    if (code !== 0) shutdown(code ?? 1);
  });

  children.push(child);
  return child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

if (!existsSync(join(root, 'server', 'node_modules'))) {
  console.error('Server dependencies are missing. Run: npm --prefix server install');
  process.exit(1);
}

console.log('LANShare — starting signaling server and dev server\n');
run('signaling', 'npx', ['tsx', 'watch', 'src/index.ts'], {
  cwd: join(root, 'server'),
  env: { ...process.env, PORT: signalingPort },
});
run('web', 'npx', ['vite', '--host'], {
  env: { ...process.env, SIGNALING_PROXY_TARGET: `http://127.0.0.1:${signalingPort}` },
});

setTimeout(() => {
  console.log(`\n  Signaling : ws://localhost:${signalingPort}/ws`);
  console.log(`  App       : http://localhost:${devPort}/`);
  console.log('\n  Open the app on a second device on the same network to transfer.\n');
}, 1500);
