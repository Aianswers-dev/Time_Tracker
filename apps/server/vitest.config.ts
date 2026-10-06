import { defineConfig } from 'vitest/config';

/**
 * Server tests run the real Worker in workerd through wrangler's
 * `createTestHarness`, with an in-memory local D1 that has the migrations in
 * `drizzle/` applied (see test/harness.ts). Each test file starts its own
 * Worker; tables are emptied before each test.
 */
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['./test/global-setup.ts'],
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
