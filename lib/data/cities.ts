/**
 * City dictionary and curator-city links (migration 115).
 *
 * Cities are free text at the edges but normalized inside: the lookup key is
 * lower-cased with collapsed whitespace, and the dictionary keeps one
 * canonical display name per key so «Москва», «москва » and «МОСКВА» are the
 * same city everywhere (matching, suggestions, curator auto-pick).
 */
import { query } from '../db'

/** Collapse whitespace, trim. Display form (keeps case as typed). */
export function normalizeCityName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/** Normalized lookup key for a city. */
export function cityKey(raw: string): string {
  return normalizeCityName(raw).toLowerCase()
}

/**
 * Remember a city in the dictionary and return its canonical display name.
 * First-writer wins on the canonical spelling; later variants map onto it.
 */
export async function rememberCity(raw: string): Promise<string> {
  const name = normalizeCityName(raw)
  if (!name) return ''
  const rows = await query<{ name: string }>(
    `INSERT INTO cities (name, name_norm) VALUES ($1, $2)
     ON CONFLICT (name_norm) DO UPDATE SET name_norm = EXCLUDED.name_norm
     RETURNING name`,
    [name, name.toLowerCase()],
  )
  return rows[0]?.name ?? name
}

/** City suggestions for inputs (prefix match first, then contains). */
export async function suggestCities(q?: string): Promise<string[]> {
  const key = q ? cityKey(q) : ''
  const rows = key
    ? await query<{ name: string }>(
        `SELECT name FROM cities
          WHERE name_norm LIKE $1 OR name_norm LIKE $2
          ORDER BY (name_norm LIKE $1) DESC, name ASC
          LIMIT 20`,
        [`${key}%`, `%${key}%`],
      )
    : await query<{ name: string }>(
        `SELECT name FROM cities ORDER BY name ASC LIMIT 50`,
      )
  return rows.map((r) => r.name)
}

/** Cities a curator covers (display names, primary city first). */
export async function listCuratorCities(curatorId: string): Promise<string[]> {
  const filtered = await query<{ city: string }>(
    `SELECT cc.city
       FROM curator_cities cc
       LEFT JOIN managers m ON m.id = cc.curator_id
      WHERE cc.curator_id = $1
      ORDER BY (lower(COALESCE(m.city, '')) = cc.city_norm) DESC, cc.city ASC`,
    [curatorId],
  )
  return filtered.map((r) => r.city)
}

/**
 * Replace the curator's city set. The first city becomes the primary one
 * (kept in managers.city for display/back-compat). Every city is remembered
 * in the dictionary and stored in its canonical spelling.
 */
export async function setCuratorCities(
  curatorId: string,
  rawCities: string[],
): Promise<string[]> {
  const seen = new Set<string>()
  const names: string[] = []
  for (const raw of rawCities) {
    const name = normalizeCityName(raw)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  if (names.length === 0) {
    throw new Error('Укажите хотя бы один город')
  }

  // Batch: remember every city in one round-trip (instead of one per city)
  // and read back the canonical spellings keyed by name_norm.
  const keys = names.map((n) => n.toLowerCase())
  const dictRows = await query<{ name: string; name_norm: string }>(
    `INSERT INTO cities (name, name_norm)
     SELECT n, k FROM unnest($1::text[], $2::text[]) AS t(n, k)
     ON CONFLICT (name_norm) DO UPDATE SET name_norm = EXCLUDED.name_norm
     RETURNING name, name_norm`,
    [names, keys],
  )
  const canonicalByKey = new Map(dictRows.map((r) => [r.name_norm, r.name]))
  const canonical = names.map(
    (n) => canonicalByKey.get(n.toLowerCase()) ?? n,
  )

  await query(`DELETE FROM curator_cities WHERE curator_id = $1`, [curatorId])
  await query(
    `INSERT INTO curator_cities (curator_id, city, city_norm)
     SELECT $1, c, lower(c) FROM unnest($2::text[]) AS t(c)
     ON CONFLICT (curator_id, city_norm) DO NOTHING`,
    [curatorId, canonical],
  )
  await query(
    `UPDATE managers SET city = $2, updated_at = now() WHERE id = $1`,
    [curatorId, canonical[0]],
  )
  return canonical
}

/** Parse a comma/semicolon-separated city list from a form field. */
export function parseCityList(raw: string): string[] {
  return raw
    .split(/[,;]/)
    .map((s) => normalizeCityName(s))
    .filter(Boolean)
}
