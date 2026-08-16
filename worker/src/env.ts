import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

// The worker shares ONE .env with the panel, but that file lives in the repo
// root — not in ./worker. A bare `import 'dotenv/config'` only looks in the
// current working directory, so a manual `cd worker && pnpm start` (or any run
// whose cwd is ./worker) would find no .env and crash on the first required()
// check below. Load the worker's own .env if present, then fall back to the
// root .env. dotenv never overrides vars already in process.env, so values
// injected by PM2 (see ecosystem.config.js) always take precedence.
const here = dirname(fileURLToPath(import.meta.url))
for (const candidate of [
  resolve(here, '../.env'), // worker/.env (optional, worker-specific overrides)
  resolve(here, '../../.env'), // repo-root .env (the shared source of truth)
]) {
  if (existsSync(candidate)) {
    loadDotenv({ path: candidate })
  }
}

/**
 * Centralised, validated environment for the worker. Fails fast on missing
 * critical config so the process never starts in a half-broken state.
 */

function required(name: string): string {
  const v = process.env[name]
  if (!v || v.trim() === '') {
    throw new Error(`Missing required env var: ${name}`)
  }
  return v
}

function optional(name: string, fallback = ''): string {
  return process.env[name] ?? fallback
}

export const env = {
  databaseUrl: required('DATABASE_URL'),
  encryptionKey: required('ENCRYPTION_KEY'),
  /** Shared secret the panel uses to call the worker's internal HTTP API. */
  workerSecret: required('WORKER_SECRET'),
  workerPort: Number(optional('WORKER_PORT', '4000')),
  /** Telegram API credentials from https://my.telegram.org. */
  telegramApiId: Number(optional('TELEGRAM_API_ID', '0')),
  telegramApiHash: optional('TELEGRAM_API_HASH', ''),
  /** Device metadata used for MTProto sessions (kept stable to avoid bans). */
  deviceModel: optional('TELEGRAM_DEVICE_MODEL', 'Omnidesk Desktop'),
  systemVersion: optional('TELEGRAM_SYSTEM_VERSION', 'Linux'),
  appVersion: optional('TELEGRAM_APP_VERSION', '1.0.0'),
  logLevel: optional('LOG_LEVEL', 'info'),
  nodeEnv: optional('NODE_ENV', 'production'),
  /**
   * Verbose login/auth diagnostics (phone shape, sendCode params, delivery
   * branch, timings). Toggle via existing config: explicit AUTH_DEBUG=1, or
   * LOG_LEVEL=debug/trace, otherwise on by default outside production (safe
   * mode). Set AUTH_DEBUG=0 to force it off everywhere.
   */
  authDebug:
    optional('AUTH_DEBUG', '') === '0'
      ? false
      : optional('AUTH_DEBUG', '') === '1' ||
        optional('LOG_LEVEL', 'info') === 'debug' ||
        optional('LOG_LEVEL', 'info') === 'trace' ||
        optional('NODE_ENV', 'production') !== 'production',
}

export function assertTelegramConfigured(): void {
  if (!env.telegramApiId || !env.telegramApiHash) {
    throw new Error(
      'Telegram is not configured. Set TELEGRAM_API_ID and TELEGRAM_API_HASH (from https://my.telegram.org).',
    )
  }
}
