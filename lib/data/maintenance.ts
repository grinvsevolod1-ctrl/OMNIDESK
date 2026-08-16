/**
 * Global maintenance kill-switch: the fake "502 Bad Gateway" flag toggled from
 * the god panel. When on, the admin & manager dashboards render a bogus 502
 * screen; the god panel itself is never gated by it. Backed by the singleton
 * `maintenance_settings` row (migration 092).
 * Split out into its own module; re-exported via lib/data.ts.
 */
import { query } from '../db'

/**
 * Read the fake-502 flag. Fails OPEN (returns false) if the table doesn't exist
 * yet (migration 092 not applied) or the DB is briefly unreachable, so a hiccup
 * can never lock every admin/manager out behind a fake outage.
 */
export async function getFake502(): Promise<boolean> {
  try {
    const rows = await query<{ fake_502: boolean }>(
      'SELECT fake_502 FROM maintenance_settings WHERE id = true LIMIT 1',
    )
    return rows[0]?.fake_502 ?? false
  } catch (err) {
    console.error('getFake502 failed (migration 092?):', err)
    return false
  }
}

/** Enable/disable the fake 502 screen for admins & managers. */
export async function setFake502(enabled: boolean): Promise<void> {
  await query(
    `INSERT INTO maintenance_settings (id, fake_502, updated_at)
       VALUES (true, $1, now())
     ON CONFLICT (id) DO UPDATE
       SET fake_502 = EXCLUDED.fake_502, updated_at = now()`,
    [enabled],
  )
}
