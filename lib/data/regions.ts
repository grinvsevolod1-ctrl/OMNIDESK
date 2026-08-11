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
}

export async function listRegions(): Promise<Region[]> {
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM regions ORDER BY name ASC`,
  )
  return rows
}

/**
 * Единое автодополнение города: матчится и имя города, и имя региона.
 * Приоритет: точное совпадение → префикс города → вхождение → регион.
 */
export async function searchCitiesWithRegions(
  q: string,
  limit = 12,
): Promise<CityWithRegion[]> {
  const key = cityKey(q)
  if (!key) return []
  const capped = Math.min(Math.max(limit, 1), 30)
  const rows = await query<{ city: string; region: string | null }>(
    `SELECT c.name AS city, r.name AS region
       FROM cities c
       LEFT JOIN regions r ON r.id = c.region_id
      WHERE c.name_norm LIKE $2
         OR c.name_norm LIKE $3
         OR lower(COALESCE(r.name, '')) LIKE $3
      ORDER BY (c.name_norm = $1) DESC,
               (c.name_norm LIKE $2) DESC,
               (c.name_norm LIKE $3) DESC,
               c.name ASC
      LIMIT ${capped}`,
    [key, `${key}%`, `%${key}%`],
  )
  return rows
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
