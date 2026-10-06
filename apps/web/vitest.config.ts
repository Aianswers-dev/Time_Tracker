import { defineConfig } from 'vitest/config';

// Data-layer tests run in Node against fake-indexeddb, without the PWA and
// Tailwind plugins from vite.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['fake-indexeddb/auto'],
  },
});
