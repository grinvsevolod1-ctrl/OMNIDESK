/**
 * Telegram account security settings (global, God-panel controlled).
 *
 * "Exclusive session" mode: when enabled, the worker keeps the connected
 * Telegram account authorized ONLY on our own session — any other active
 * authorization (a real Telegram client, another linked device, etc.) is
 * terminated automatically, both right after we connect and on a periodic
 * sweep. This keeps the account under our exclusive control.
 *
 * The flag lives in the shared `app_settings` key-value table (jsonb) so both
 * the Next.js app (God-panel toggle) and the worker (enforcement) read the same
 * source of truth. It is ON by default when unset.
 */
import { query } from '../db'

const TELEGRAM_EXCLUSIVE_KEY = 'telegram_exclusive_session'

/** True when exclusive-session enforcement is enabled. Defaults to ON. */
export async function getTelegramExclusiveSession(): Promise<boolean> {
  const rows = await query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [TELEGRAM_EXCLUSIVE_KEY],
  )
  return normalizeExclusive(rows[0]?.value)
}

/** Persist the exclusive-session flag. */
export async function setTelegramExclusiveSession(
  enabled: boolean,
): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [TELEGRAM_EXCLUSIVE_KEY, JSON.stringify({ enabled })],
  )
}

/**
 * Coerce the stored jsonb into a boolean. Accepts `{ enabled: bool }` (our
 * format), a bare boolean, and defaults to true (ON) for anything else / unset.
 */
function normalizeExclusive(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'boolean') return value
  if (typeof value === 'object' && 'enabled' in (value as object)) {
    return Boolean((value as { enabled?: unknown }).enabled)
  }
  return true
}
