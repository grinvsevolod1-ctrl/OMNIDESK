/**
 * Curator lookup for lead transfer pickers: city-scoped search and the full
 * active roster with per-curator load. Split out of lead-cards.ts; re-exported
 * there so existing imports keep working.
 */
import { query } from '../db'
import type { Manager } from '../types'
import { cityKey } from './cities'
import { managerColumns, toManager, type ManagerRow } from './shared'

/** A curator (or any manager row) with the number of active leads assigned. */
export interface CuratorWithLoad extends Manager {
  activeLeads: number
  /** All covered cities (curator_cities, migration 115). Falls back to [city]. */
  cities: string[]
}

/** SQL fragment: aggregated city list with legacy managers.city fallback. */
const CITIES_AGG = `
  COALESCE(
    (SELECT array_agg(cc.city ORDER BY cc.city)
       FROM curator_cities cc WHERE cc.curator_id = managers.id),
    CASE WHEN city IS NOT NULL AND city <> ''
         THEN ARRAY[city] ELSE ARRAY[]::text[] END
  ) AS cities`

/**
 * Active curators covering a matching city (case-insensitive contains),
 * sorted by current load ascending so the least-busy curator comes first.
 * A curator may cover several cities (curator_cities, migration 115);
 * managers.city is a legacy fallback for rows without links.
 *
 * Region awareness (migration 124): a curator whose covered entry is a REGION
 * («Чеченская Республика») matches every city of that region; and when the
 * lead's city IS a region (or its alias, e.g. «Чечня»), curators covering any
 * city inside that region match too.
 */
export async function findCuratorsByCity(
  cityQuery: string,
): Promise<CuratorWithLoad[]> {
  const q = cityKey(cityQuery)
  if (!q) return []
  const rows = await query<
    ManagerRow & { active_leads: string; cities: string[] | null }
  >(
    `WITH lead_region AS (
       -- Регион запроса: сам запрос — регион/алиас, либо регион города.
       SELECT r.id, r.name_norm FROM regions r
        WHERE r.name_norm = $2
           OR EXISTS (SELECT 1 FROM unnest(r.aliases) a WHERE lower(a) = $2)
       UNION
       SELECT r.id, r.name_norm
         FROM cities c JOIN regions r ON r.id = c.region_id
        WHERE c.name_norm = $2
     )
     SELECT ${managerColumns()},
            (SELECT count(*) FROM lead_cards lc
              WHERE lc.curator_id = managers.id
                AND lc.transferred_at IS NOT NULL
                AND (lc.status IS NULL OR lc.status NOT IN ('refused', 'left'))
            )::int AS active_leads,
            ${CITIES_AGG}
       FROM managers
      WHERE role = 'curator'
        AND status = 'active'
        AND (
          -- Прямое совпадение по городу/тексту (как раньше).
          EXISTS (SELECT 1 FROM curator_cities cc
                   WHERE cc.curator_id = managers.id
                     AND cc.city_norm LIKE $1)
          -- Куратор покрывает регион, в котором лежит город запроса.
          OR EXISTS (SELECT 1
                       FROM curator_cities cc
                       JOIN lead_region lr ON lr.name_norm = cc.city_norm
                      WHERE cc.curator_id = managers.id)
          -- Запрос — регион: матчатся кураторы любого города этого региона.
          OR EXISTS (SELECT 1
                       FROM curator_cities cc
                       JOIN cities c ON c.name_norm = cc.city_norm
                       JOIN lead_region lr ON lr.id = c.region_id
                      WHERE cc.curator_id = managers.id)
          OR (NOT EXISTS (SELECT 1 FROM curator_cities cc2
                           WHERE cc2.curator_id = managers.id)
              AND city IS NOT NULL AND lower(city) LIKE $1)
        )
      ORDER BY active_leads ASC, city ASC NULLS LAST, name ASC
      LIMIT 20`,
    [`%${q}%`, q],
  )
  return rows.map((r) => ({
    ...toManager(r),
    activeLeads: Number(r.active_leads ?? 0),
    cities: r.cities ?? [],
  }))
}

/** All active curators (for admin transfer picker), with load counts. */
export async function listActiveCurators(): Promise<CuratorWithLoad[]> {
  const rows = await query<
    ManagerRow & { active_leads: string; cities: string[] | null }
  >(
    `SELECT ${managerColumns()},
            (SELECT count(*) FROM lead_cards lc
              WHERE lc.curator_id = managers.id
                AND lc.transferred_at IS NOT NULL
                AND (lc.status IS NULL OR lc.status NOT IN ('refused', 'left'))
            )::int AS active_leads,
            ${CITIES_AGG}
       FROM managers
      WHERE role = 'curator' AND status = 'active'
      ORDER BY city ASC NULLS LAST, name ASC`,
  )
  return rows.map((r) => ({
    ...toManager(r),
    activeLeads: Number(r.active_leads ?? 0),
    cities: r.cities ?? [],
  }))
}

/** One row of the full status trail (migration 115). */
