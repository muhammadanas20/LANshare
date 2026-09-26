import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// jsdom lacks matchMedia — provide a controllable stub.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
}

// jsdom has no WebRTC — individual tests provide fakes where a connection is needed.
if (!('RTCPeerConnection' in window)) {
  Object.defineProperty(window, 'RTCPeerConnection', { writable: true, value: undefined });
}

/**
 * jsdom's Blob/File are missing the binary read helpers that modern browsers ship
 * (arrayBuffer/text/stream). Production relies on them, so polyfill them here using
 * jsdom's own FileReader.
 */
if (typeof Blob !== 'undefined' && !Blob.prototype.arrayBuffer) {
  Object.defineProperty(Blob.prototype, 'arrayBuffer', {
    writable: true,
    value(this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error ?? new Error('read failed'));
        reader.readAsArrayBuffer(this);
      });
    },
  });
}

if (typeof Blob !== 'undefined' && !Blob.prototype.text) {
  Object.defineProperty(Blob.prototype, 'text', {
    writable: true,
    value(this: Blob) {
      return this.arrayBuffer().then((buffer) => new TextDecoder().decode(buffer));
    },
  });
}

if (typeof Blob !== 'undefined' && !Blob.prototype.stream && typeof ReadableStream !== 'undefined') {
  Object.defineProperty(Blob.prototype, 'stream', {
    writable: true,
    value(this: Blob) {
      const blob = this;
      return new ReadableStream<Uint8Array>({
        async start(controller) {
          const buffer = await blob.arrayBuffer();
          controller.enqueue(new Uint8Array(buffer));
          controller.close();
        },
      });
    },
  });
}

// jsdom does not implement WebCrypto subtle — use Node's implementation so the
// file integrity (SHA-256) path is exercised in tests.
if (!globalThis.crypto?.subtle) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { webcrypto } = await import('node:crypto');
  Object.defineProperty(window, 'crypto', { writable: true, value: webcrypto });
  Object.defineProperty(globalThis, 'crypto', { writable: true, value: webcrypto });
}

if (!('createObjectURL' in URL)) {
  Object.defineProperty(URL, 'createObjectURL', { writable: true, value: () => 'blob:test' });
  Object.defineProperty(URL, 'revokeObjectURL', { writable: true, value: () => undefined });
}

afterEach(() => {
  cleanup();
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});
