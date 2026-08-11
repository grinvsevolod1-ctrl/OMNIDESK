/**
 * Региональный справочник (миграция 122): 89 субъектов РФ + привязка городов.
 * Автодополнение «город (регион)» — серверное, ничего не грузится заранее.
 */
import { query } from '../db'
import { cityKey } from './cities'

export interface Region {
  id: string
  name: string
}

export interface CityWithRegion {
  city: string
  region: string | null
  /** true — это целый регион как значение («Чеченская Республика»). */
  isRegion?: boolean
}

export async function listRegions(): Promise<Region[]> {
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM regions ORDER BY name ASC`,
  )
  return rows
}

/**
 * Единое автодополнение города: матчится имя города, имя региона и его
 * алиасы («Чечня» → «Чеченская Республика»). Регионы возвращаются отдельными
 * подсказками с isRegion=true — их можно выбрать как значение (весь регион).
 * Приоритет: точное совпадение → префикс города → вхождение → регион.
 */
export async function searchCitiesWithRegions(
  q: string,
  limit = 12,
): Promise<CityWithRegion[]> {
  const key = cityKey(q)
  if (!key) return []
  const capped = Math.min(Math.max(limit, 1), 30)

  // Регионы (по имени или алиасу) — целиком назначаемые значения.
  const regionRows = await query<{ name: string }>(
    `SELECT name FROM regions
      WHERE name_norm LIKE $2
         OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) LIKE $2)
      ORDER BY (name_norm = $1) DESC, name ASC
      LIMIT 5`,
    [key, `%${key}%`],
  )
  const regions: CityWithRegion[] = regionRows.map((r) => ({
    city: r.name,
    region: null,
    isRegion: true,
  }))

  const cityLimit = Math.max(capped - regions.length, 4)
  const rows = await query<{ city: string; region: string | null }>(
    `SELECT c.name AS city, r.name AS region
       FROM cities c
       LEFT JOIN regions r ON r.id = c.region_id
      WHERE c.name_norm LIKE $2
         OR c.name_norm LIKE $3
         OR lower(COALESCE(r.name, '')) LIKE $3
         OR EXISTS (SELECT 1 FROM unnest(COALESCE(r.aliases, '{}')) a
                     WHERE lower(a) LIKE $3)
      ORDER BY (c.name_norm = $1) DESC,
               (c.name_norm LIKE $2) DESC,
               (c.name_norm LIKE $3) DESC,
               c.name ASC
      LIMIT ${cityLimit}`,
    [key, `${key}%`, `%${key}%`],
  )
  // Регионы после точного совпадения города, но перед прочими: запрос
  // «чечня» должен сразу предлагать «Чеченская Республика — весь регион».
  const exact = rows.filter((r) => cityKey(r.city) === key)
  const rest = rows.filter((r) => cityKey(r.city) !== key)
  return [...exact, ...regions, ...rest]
}

/**
 * Каноническое значение для поля «город»: город из базы (каноническое
 * написание), регион по имени/алиасу («чечня» → «Чеченская Республика»)
 * или null, если в справочнике ничего нет.
 */
export async function resolveCityOrRegion(
  raw: string,
): Promise<{ value: string; isRegion: boolean } | null> {
  const key = cityKey(raw)
  if (!key) return null
  const city = await query<{ name: string }>(
    `SELECT name FROM cities WHERE name_norm = $1 LIMIT 1`,
    [key],
  )
  if (city[0]) return { value: city[0].name, isRegion: false }
  const region = await query<{ name: string }>(
    `SELECT name FROM regions
      WHERE name_norm = $1
         OR EXISTS (SELECT 1 FROM unnest(aliases) a WHERE lower(a) = $1)
      LIMIT 1`,
    [key],
  )
  if (region[0]) return { value: region[0].name, isRegion: true }
  return null
}

/** Регион города по нормализованному имени (для карточки/выгрузки). */
export async function getRegionForCity(city: string): Promise<string | null> {
  const key = cityKey(city)
  if (!key) return null
  const rows = await query<{ region: string | null }>(
    `SELECT r.name AS region
       FROM cities c
       JOIN regions r ON r.id = c.region_id
      WHERE c.name_norm = $1
      LIMIT 1`,
    [key],
  )
  return rows[0]?.region ?? null
}
