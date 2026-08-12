import { defineConfig } from 'vitest/config'

/**
 * Integration test runner (`pnpm test:integration`).
 *
 * These tests exercise REAL database queries (race conditions, ownership
 * scoping, throttle flows) against the Postgres pointed to by DATABASE_URL.
 * Every suite guards itself with `describe.skipIf(!process.env.DATABASE_URL)`
 * so the command is safe to run anywhere: without a database the run is a
 * no-op (hence --passWithNoTests in the npm script), on CI/VPS it verifies
 * the invariants unit tests cannot (unique indexes, ON CONFLICT behavior,
 * cross-request races).
 *
 * They run serially (singleThread) because they create and clean up shared
 * fixture rows — parallel workers would race each other's cleanup.
 */
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['**/node_modules/**', '.next/**'],
    pool: 'threads',
    // Serial execution: suites share DB fixtures and clean up after themselves.
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    alias: {
      'server-only': new URL('./tests/stubs/server-only.ts', import.meta.url)
        .pathname,
      '@': new URL('.', import.meta.url).pathname.replace(/\/$/, ''),
    },
  },
})
