import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The signaling server is its own package with its own dependencies, and its suite must run
 * with nothing but `server/node_modules` present.
 *
 * This config already existed, but it did not stop Vite from loading the repository-root
 * `postcss.config.js` — which loads `tailwindcss`, a *frontend* dependency that is not installed
 * here. Locally that went unnoticed because a full-repository install had already populated the
 * root `node_modules`; in CI the signaling job installs only this package, so the CSS toolchain
 * was missing and the suite died with "Cannot find module 'tailwindcss'" before a single test
 * ran. Pinning the root to this package (so nothing above it is read) and handing Vite an inline,
 * empty PostCSS config keeps the server suite independent of the frontend build tooling in every
 * environment.
 */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  css: { postcss: { plugins: [] } },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    globals: false,
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
