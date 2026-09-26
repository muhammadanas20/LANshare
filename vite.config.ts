import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Vite configuration for LANShare.
 *
 * Environment variables (see `.env.example`):
 *  - VITE_SIGNALING_URL  Full WebSocket URL of the signaling server, e.g. wss://signal.example.com/ws
 *                        When empty, the app connects to `<origin>/ws`, which works for local
 *                        development (Vite proxies /ws to the signaling server) and for deployments
 *                        where the frontend and signaling server share a host/reverse-proxy.
 *  - VITE_BASE_PATH      Base path for static hosting (GitHub Pages project sites: /lan-share/)
 *  - VITE_ICE_SERVERS    JSON array of RTCIceServer objects (STUN/TURN). Optional.
 *  - VITE_APP_NAME       Optional application name override.
 */
export default defineConfig(({ mode }) => {
  const isProd = mode === 'production';
  /**
   * Single-file build (`npm run bundle:offline`): everything — JavaScript, CSS, nothing to
   * fetch — inlined into one HTML file that works from `file://`. That is what lets a phone
   * and a computer share files with no server, no install and no internet: the file itself is
   * the app, carried by USB, AirDrop or an email attachment.
   */
  const singleFile = process.env.VITE_SINGLE_FILE === '1';

  const plugins: PluginOption[] = [react()];

  return {
    base: process.env.VITE_BASE_PATH || '/',
    plugins,
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
      },
    },
    server: {
      host: true,
      port: 5173,
      strictPort: false,
      // Allow access through sandbox/preview hostnames and LAN IPs.
      allowedHosts: true,
      // Reflect the request origin so embedded contexts work: a sandboxed iframe
      // (opaque origin) requests the app with `Origin: null` and module scripts are
      // CORS-checked, so without this the shell never loads.
      cors: { origin: true },
      proxy: {
        // Same-origin signaling for local development: browser -> vite -> signaling server.
        '/ws': {
          target: process.env.SIGNALING_PROXY_TARGET || 'http://localhost:8080',
          ws: true,
          changeOrigin: true,
        },
      },
    },
    preview: {
      host: true,
      port: 4173,
      cors: { origin: true },
      proxy: {
        '/ws': {
          target: process.env.SIGNALING_PROXY_TARGET || 'http://localhost:8080',
          ws: true,
          changeOrigin: true,
        },
      },
    },
    build: {
      target: 'es2020',
      sourcemap: singleFile ? false : !isProd,
      chunkSizeWarningLimit: 900,
      ...(singleFile
        ? {
            // One chunk, no separate CSS file, and every asset inlined: an inline module script
            // cannot import siblings from `file://`, so there must be nothing left to import.
            cssCodeSplit: false,
            assetsInlineLimit: Number.MAX_SAFE_INTEGER,
            outDir: 'dist-offline/single',
            emptyOutDir: true,
          }
        : {}),
      rollupOptions: {
        output: singleFile
          ? { inlineDynamicImports: true }
          : {
              manualChunks: {
                react: ['react', 'react-dom'],
                vendor: ['lucide-react', 'qrcode', 'fflate', 'zod'],
              },
            },
      },
    },
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.ts'],
      include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
      css: false,
      restoreMocks: true,
    },
  };
});
