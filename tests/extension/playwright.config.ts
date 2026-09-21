import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 35_000,
  expect: { timeout: 5_000 },
  workers: 1,
  reporter: 'list',
  outputDir: '/tmp/agent-browser/omnidesk-extension-tests',
})
