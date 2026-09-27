import 'server-only'

import { query } from './db'
import type { PageStatePayload } from './god-sites-types'

/**
 * Global «email администратора» for every vitrine (god-panel «Сайты» tab).
 * The page shows it in the modal opened by a click on the sidebar balance.
 * Stored in app_settings; cached briefly because vitrines poll /state often.
 */

const KEY = 'god_sites.contact'
const CACHE_MS = 15_000
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

let cache: { value: string; at: number } | null = null

export async function getSitesContactEmail(): Promise<string> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value
  const rows = await query<{ value: { email?: string } }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [KEY],
  )
  const value = String(rows[0]?.value?.email ?? '').trim()
  cache = { value, at: Date.now() }
  return value
}

export type SetContactResult = { ok: true; email: string } | { ok: false; message: string }

export async function setSitesContactEmail(raw: string): Promise<SetContactResult> {
  const email = String(raw ?? '').trim()
  if (email.length > 254) return { ok: false, message: 'Слишком длинный email' }
  if (email && !EMAIL_RE.test(email)) return { ok: false, message: 'Некорректный email' }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [KEY, JSON.stringify({ email })],
  )
  cache = { value: email, at: Date.now() }
  return { ok: true, email }
}

/** Adds `contactEmail` to the page payload (omitted when blank). */
export function withContactEmail(
  payload: PageStatePayload,
  email: string,
): PageStatePayload {
  return email ? { ...payload, contactEmail: email } : payload
}
