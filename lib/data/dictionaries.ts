/**
 * Server data layer for managed dictionaries (see lib/dictionaries.ts).
 *
 * Storage: the shared `app_settings` key-value table (jsonb) under the
 * `dictionaries` key — same pattern as offhours_messengers / telemost. The
 * stored value is a PARTIAL override; defaults are merged in at read time so
 * new dictionary sections added in code appear automatically.
 */
import { query } from '../db'
import {
  resolveDictionaries,
  type Dictionaries,
} from '../dictionaries'

export const DICTIONARIES_SETTINGS_KEY = 'dictionaries'

/**
 * Read + resolve the dictionaries (always returns a complete shape).
 *
 * FAIL-OPEN by design: dictionaries are cosmetic captions. This is called
 * from the admin LAYOUT, so a DB hiccup here would otherwise take down every
 * admin page — including ones that don't need the DB at all (login redirect,
 * error screens). Defaults are always safe to render.
 */
export async function getDictionaries(): Promise<Dictionaries> {
  try {
    const rows = await query<{ value: unknown }>(
      `SELECT value FROM app_settings WHERE key = $1`,
      [DICTIONARIES_SETTINGS_KEY],
    )
    return resolveDictionaries(rows[0]?.value)
  } catch (err) {
    console.error('[dictionaries] falling back to defaults:', err)
    return resolveDictionaries(null)
  }
}

/** Raw stored override (for seeding / diffing), may be null. */
export async function getRawDictionaries(): Promise<unknown> {
  const rows = await query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [DICTIONARIES_SETTINGS_KEY],
  )
  return rows[0]?.value ?? null
}

/**
 * Persist a full dictionaries value (callers pass the resolved object after
 * applying their edit — a full write keeps the stored shape self-describing
 * and trivially inspectable).
 */
export async function saveDictionaries(value: Dictionaries): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [DICTIONARIES_SETTINGS_KEY, JSON.stringify(value)],
  )
}

/**
 * Apply a scoped edit: section + key + new meta/label. Returns the updated,
 * fully resolved dictionaries. Rejects unknown sections/keys so the copilot
 * cannot invent entries with unstable keys.
 */
export async function updateDictionaryEntry(input: {
  section: keyof Dictionaries
  key?: string
  label?: string
  description?: string
  /** For shellQuickCommands: full replacement list. */
  quickCommands?: { label: string; prompt: string }[]
  /** For shellGreeting. */
  text?: string
}): Promise<{ ok: true; dict: Dictionaries } | { ok: false; message: string }> {
  const dict = await getDictionaries()
  const { section } = input

  if (section === 'shellGreeting') {
    if (!input.text?.trim()) return { ok: false, message: 'Пустой текст приветствия' }
    dict.shellGreeting = input.text.trim()
  } else if (section === 'shellQuickCommands') {
    if (!input.quickCommands?.length)
      return { ok: false, message: 'Нужен непустой список быстрых команд' }
    dict.shellQuickCommands = input.quickCommands
      .map((c) => ({ label: c.label.trim(), prompt: c.prompt.trim() }))
      .filter((c) => c.label && c.prompt)
  } else if (section === 'leadStatuses' || section === 'notLiquidReasons') {
    const map = dict[section] as Record<string, { label: string; description: string }>
    if (!input.key || !(input.key in map))
      return { ok: false, message: `Неизвестный ключ «${input.key}» в разделе ${section}` }
    if (input.label?.trim()) map[input.key].label = input.label.trim()
    if (typeof input.description === 'string')
      map[input.key].description = input.description
  } else {
    const map = dict[section] as Record<string, string>
    if (!input.key || !(input.key in map))
      return { ok: false, message: `Неизвестный ключ «${input.key}» в разделе ${section}` }
    if (!input.label?.trim()) return { ok: false, message: 'Пустое название' }
    map[input.key] = input.label.trim()
  }

  await saveDictionaries(dict)
  return { ok: true, dict }
}
