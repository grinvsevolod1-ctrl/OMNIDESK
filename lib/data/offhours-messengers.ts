/**
 * Off-hours messenger routing (WhatsApp/Telegram fallback links) and their
 * round-robin assignment counter.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import { whatsappLinkFromPhone } from '../offhours'

/* ----------------------- Off-hours messengers ----------------------- */

/**
 * Admin-configured messenger fallbacks shown when the live chat is outside
 * working hours. Telegram links and WhatsApp phone numbers are stored as plain
 * lists; they are handed to visitors in round-robin order at request time.
 */
export interface OffhoursMessengers {
  telegramLinks: string[]
  whatsappPhones: string[]
}

const OFFHOURS_SETTINGS_KEY = 'offhours_messengers'

/** Read the configured messenger lists (always returns a valid shape). */
export async function getOffhoursMessengers(): Promise<OffhoursMessengers> {
  const rows = await query<{ value: OffhoursMessengers }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [OFFHOURS_SETTINGS_KEY],
  )
  const value = rows[0]?.value
  return {
    telegramLinks: Array.isArray(value?.telegramLinks)
      ? value.telegramLinks.filter((v): v is string => typeof v === 'string')
      : [],
    whatsappPhones: Array.isArray(value?.whatsappPhones)
      ? value.whatsappPhones.filter((v): v is string => typeof v === 'string')
      : [],
  }
}

/** Admin: persist the messenger lists (full replace). */
export async function saveOffhoursMessengers(
  input: OffhoursMessengers,
): Promise<void> {
  const value: OffhoursMessengers = {
    telegramLinks: input.telegramLinks.map((v) => v.trim()).filter(Boolean),
    whatsappPhones: input.whatsappPhones.map((v) => v.trim()).filter(Boolean),
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [OFFHOURS_SETTINGS_KEY, JSON.stringify(value)],
  )
}

/**
 * Atomically take the next index from a named round-robin counter. The counter
 * grows forever; callers apply `% length` so distribution wraps around the
 * configured list ("when links run out, continue from the start").
 */
async function nextRoundRobinIndex(name: string): Promise<number> {
  const rows = await query<{ n: string | number }>(
    `INSERT INTO offhours_counters (name, n)
       VALUES ($1, 1)
     ON CONFLICT (name)
       DO UPDATE SET n = offhours_counters.n + 1
     RETURNING n`,
    [name],
  )
  // The just-incremented value is the 1-based count; convert to a 0-based index.
  const n = Number(rows[0]?.n ?? 1)
  return (n - 1) % Number.MAX_SAFE_INTEGER
}

export interface OffhoursAssignment {
  telegram: string | null
  whatsapp: string | null
}

/**
 * Hand the next messenger links to a visitor in round-robin order: the 1st
 * visitor gets link #1, the 2nd gets #2, and so on, wrapping around when the
 * list is exhausted. Telegram and WhatsApp advance independently.
 */
export async function nextOffhoursAssignment(): Promise<OffhoursAssignment> {
  const { telegramLinks, whatsappPhones } = await getOffhoursMessengers()

  let telegram: string | null = null
  if (telegramLinks.length > 0) {
    const idx = await nextRoundRobinIndex('telegram')
    telegram = telegramLinks[idx % telegramLinks.length] ?? null
  }

  let whatsapp: string | null = null
  if (whatsappPhones.length > 0) {
    const idx = await nextRoundRobinIndex('whatsapp')
    const phone = whatsappPhones[idx % whatsappPhones.length]
    whatsapp = phone ? whatsappLinkFromPhone(phone) : null
  }

  return { telegram, whatsapp }
}


/* Analytics & reporting — extracted to ./data/analytics */
