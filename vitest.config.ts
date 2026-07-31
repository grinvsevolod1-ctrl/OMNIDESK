import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/browser/**', '.next/**'],
    // `server-only` throws if imported outside a React Server Component build.
    // Stub it so we can unit-test server-side modules that guard themselves
    // with `import 'server-only'` (e.g. ssrf-guard, god-gate).
    alias: {
      'server-only': new URL('./tests/stubs/server-only.ts', import.meta.url)
        .pathname,
    },
  },
})
