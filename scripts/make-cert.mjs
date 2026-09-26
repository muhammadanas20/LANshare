/**
 * `npm run cert` — generate a local TLS certificate for the offline LAN mode.
 *
 * Transfers work fine over plain HTTP on a LAN; a certificate is only needed to *install*
 * LANShare as an app on a phone, because service workers require a secure context. The
 * certificate is self-signed, so browsers show a one-time warning until it is trusted —
 * that is the honest trade-off of running without the internet.
 *
 * Uses the `openssl` binary that ships with macOS, Linux and Git for Windows; no npm
 * dependency is added for this. The generated files live in `server/.certs/` (gitignored).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { networkInterfaces, hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { X509Certificate } from 'node:crypto';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const certDir = join(root, 'server', '.certs');
const certPath = join(certDir, 'cert.pem');
const keyPath = join(certDir, 'key.pem');
const force = process.argv.includes('--force');

function lanAddresses() {
  const found = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) found.push(entry.address);
    }
  }
  return [...new Set(found)].sort();
}

function hasOpenssl() {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

if (!hasOpenssl()) {
  console.error(
    'openssl was not found on PATH.\n' +
      'Options: install OpenSSL, install mkcert (https://github.com/FiloSottile/mkcert) and run\n' +
      '`mkcert -cert-file server/.certs/cert.pem -key-file server/.certs/key.pem <your-lan-ip>`,\n' +
      'or keep using plain HTTP — transfers do not need a certificate.',
  );
  process.exit(1);
}

if (existsSync(certPath) && existsSync(keyPath) && !force) {
  const existing = new X509Certificate(readFileSync(certPath));
  console.log(`A certificate already exists (valid until ${existing.validTo}).`);
  console.log(`Re-run with --force to replace it, e.g. after your LAN address changed.`);
  process.exit(0);
}

const addresses = lanAddresses();
const host = hostname().split('.')[0];
// Every name a device might type: localhost, the mDNS name, and each LAN address.
const sans = ['DNS:localhost', `DNS:${host}.local`, 'IP:127.0.0.1', ...addresses.map((a) => `IP:${a}`)].join(',');

mkdirSync(certDir, { recursive: true });
console.log(`Generating a self-signed certificate for: ${sans.replace(/DNS:|IP:/g, ' ').trim()}`);

execFileSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
    '-keyout', keyPath,
    '-out', certPath,
    '-subj', `/CN=LANShare (${host})`,
    '-addext', `subjectAltName=${sans}`,
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth',
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

const written = new X509Certificate(readFileSync(certPath));
console.log(`\nWrote ${certPath}\n      ${keyPath}`);
console.log(`Valid until ${written.validTo}.`);
console.log(
  '\nThe certificate is self-signed, so each device shows a one-time warning:\n' +
    '  · Desktop Chrome/Edge: "Advanced" → "Proceed".\n' +
    '  · Android Chrome: same, then the app can be installed.\n' +
    '  · iPhone/iPad: Safari → "Show Details" → "visit this website"; for a warning-free\n' +
    '    install you must trust the profile under Settings → General → VPN & Device Management\n' +
    '    and enable it under Settings → General → About → Certificate Trust Settings.\n' +
    '\nTransfers themselves do not need any of this — plain HTTP is enough for sending files.',
);
