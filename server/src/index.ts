/** LANShare signaling server entry point. */
import { readFileSync } from 'node:fs';
import { createSignalingServer } from './server.js';
import { serverConfig } from './config.js';
import { log } from './logger.js';
import { hostLabel, joinUrls } from './lan.js';

/**
 * Optional TLS: only needed to install the app as a PWA on a phone (service workers require
 * a secure context). Plain-HTTP LAN mode handles transfers fine without it.
 */
function loadTls(): { cert: string; key: string } | undefined {
  const { certPath, keyPath } = serverConfig.tls;
  if (!certPath || !keyPath) return undefined;
  try {
    return { cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
  } catch (error) {
    log.warn('TLS material could not be read — falling back to HTTP', {
      error: (error as Error).message,
      certPath,
      keyPath,
    });
    return undefined;
  }
}

const tls = loadTls();
const server = createSignalingServer({ tls });

server
  .listen()
  .then((port) => {
    const scheme = tls ? 'https' : 'http';
    log.info('LANShare signaling server listening', {
      port,
      host: serverConfig.host,
      path: '/ws',
      health: '/health',
      origins: serverConfig.allowedOrigins.length ? serverConfig.allowedOrigins : 'any',
      turn: serverConfig.turn.urls.length > 0,
      offline: serverConfig.offlineMode,
      servingFrontend: serverConfig.serveStatic,
      version: serverConfig.version,
    });

    if (serverConfig.offlineMode) {
      log.info('offline LAN mode: no internet required, no external STUN advertised');
    }
    if (serverConfig.serveStatic) {
      const urls = joinUrls(port, scheme);
      log.info(`frontend is served by this process — open one of these on any device on the same network`);
      if (urls.length === 0) {
        log.warn('no non-internal IPv4 address found; devices must use the address of the active interface');
      }
      for (const url of urls) {
        // Plain stdout (not JSON) so the one-line-per-address banner is unmissable.
        console.log(`  →  ${scheme}://${hostLabel()}.local:${port}   ${url}`);
      }
      if (scheme === 'http') {
        console.log('     (HTTP on the LAN: transfers work everywhere. For "install as app" on a phone, run with TLS — see README → Offline.)');
      }
    }
  })
  .catch((error: Error) => {
    log.error('Failed to start signaling server', { error: error.message });
    process.exit(1);
  });

async function shutdown(signal: string): Promise<void> {
  log.info('shutting down', { signal });
  const timeout = setTimeout(() => process.exit(1), 5000);
  timeout.unref?.();
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    log.error('shutdown error', { error: (error as Error).message });
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('unhandled rejection', { reason: String(reason) });
});
process.on('uncaughtException', (error) => {
  log.error('uncaught exception', { error: error.message });
});
