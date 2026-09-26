/**
 * Local-network helpers for offline mode.
 *
 * When LANShare runs on the LAN with no internet, the host machine must tell its owner
 * which addresses the other devices should open. Nothing here is exposed to peers except
 * the join URLs the host already knows — the app never displays a peer's IP address.
 */
import { hostname, networkInterfaces } from 'node:os';

/** Non-internal IPv4 addresses of this machine, in stable order. */
export function lanAddresses(interfaces = networkInterfaces()): string[] {
  const addresses: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      addresses.push(entry.address);
    }
  }
  return Array.from(new Set(addresses)).sort();
}

/** Join URLs a phone or another computer can open, e.g. `http://192.168.1.23:8080`. */
export function joinUrls(port: number, protocol: 'http' | 'https' = 'http', interfaces?: ReturnType<typeof networkInterfaces>): string[] {
  return lanAddresses(interfaces).map((address) => `${protocol}://${address}:${port}`);
}

/**
 * A short host label for the terminal banner. `hostname()` can return a bare name or an
 * FQDN; only the first label is interesting to a human.
 */
export function hostLabel(): string {
  return hostname().split('.')[0] || 'this device';
}
