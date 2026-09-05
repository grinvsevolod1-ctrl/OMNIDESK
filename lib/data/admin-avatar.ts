import { query } from '@/lib/db'

/**
 * Аватарка администратора. У админа нет строки в `managers` (это env-аккаунт),
 * поэтому его аватар хранится в общей kv-таблице `app_settings` под ключом
 * `admin_avatar:{sub}` — своя картинка на каждого админа. Значение — либо путь
 * к готовому образу (/avatars/demon-XX.png), либо data:-URL загруженного фото.
 */

function keyFor(sub: string): string {
  return `admin_avatar:${sub}`
}

/** Прочитать аватар админа (null — если не задан). */
export async function getAdminAvatar(sub: string): Promise<string | null> {
  const rows = await query<{ value: unknown }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [keyFor(sub)],
  )
  const v = rows[0]?.value
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Сохранить (или сбросить при null) аватар админа. */
export async function setAdminAvatar(
  sub: string,
  value: string | null,
): Promise<void> {
  if (value === null) {
    await query(`DELETE FROM app_settings WHERE key = $1`, [keyFor(sub)])
    return
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [keyFor(sub), JSON.stringify(value)],
  )
}
