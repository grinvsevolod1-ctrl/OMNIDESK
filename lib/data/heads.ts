/**
 * Руководители (role = 'head', миграция 141): учётки в той же таблице
 * managers; связь «руководитель → его кураторы» — в head_curators (куратор
 * принадлежит максимум одному руководителю). Руководитель видит только лидов
 * СВОИХ кураторов; право на запись (поля/статусы/комментарии/передача)
 * контролируется флагом managers.head_can_edit.
 */
import { query, withTransaction } from '../db'
import type { Manager } from '../types'
import {
  excludeAdminSql,
  managerColumns,
  toManager,
  type ManagerRow,
} from './shared'
import {
  CARD_SELECT,
  toLeadCard,
  type LeadCard,
  type LeadCardRow,
} from './lead-cards-core'

/** List head accounts (role = 'head'), newest-first. */
export async function listHeads(): Promise<Manager[]> {
  const rows = await query<ManagerRow>(
    `SELECT ${managerColumns()} FROM managers
      WHERE role = 'head' ${excludeAdminSql('managers')}
      ORDER BY created_at DESC`,
  )
  return rows.map(toManager)
}

/** Set the head's edit permission («только просмотр» / «редактирование»). */
export async function setHeadCanEdit(
  headId: string,
  canEdit: boolean,
): Promise<void> {
  await query(
    `UPDATE managers SET head_can_edit = $2 WHERE id = $1 AND role = 'head'`,
    [headId, canEdit],
  )
}

/** Кураторы, закреплённые за руководителем (с числом активных лидов). */
export interface HeadCurator extends Manager {
  activeLeads: number
}

export async function listCuratorsOfHead(
  headId: string,
): Promise<HeadCurator[]> {
  const rows = await query<ManagerRow & { active_leads: number }>(
    `SELECT ${managerColumns('m')},
            (SELECT COUNT(*)::int FROM lead_cards lc
              WHERE lc.curator_id = m.id
                AND lc.transferred_at IS NOT NULL
                AND lc.archived_at IS NULL) AS active_leads
       FROM head_curators hc
       JOIN managers m ON m.id = hc.curator_id
      WHERE hc.head_id = $1 AND m.role = 'curator'
      ORDER BY m.name`,
    [headId],
  )
  return rows.map((r) => ({ ...toManager(r), activeLeads: r.active_leads }))
}

/** Ids of the head's curators — the base of every head-scoped ACL check. */
export async function listCuratorIdsOfHead(headId: string): Promise<string[]> {
  const rows = await query<{ curator_id: string }>(
    `SELECT curator_id FROM head_curators WHERE head_id = $1`,
    [headId],
  )
  return rows.map((r) => r.curator_id)
}

/** True when the curator belongs to this head's group. */
export async function isCuratorOfHead(
  headId: string,
  curatorId: string | null | undefined,
): Promise<boolean> {
  if (!curatorId) return false
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM head_curators
      WHERE head_id = $1 AND curator_id = $2 LIMIT 1`,
    [headId, curatorId],
  )
  return !!rows[0]
}

/** Который руководитель закреплён за куратором (для админ-таблицы). */
export async function mapCuratorHeads(): Promise<
  Map<string, { headId: string; headName: string }>
> {
  const rows = await query<{
    curator_id: string
    head_id: string
    head_name: string
  }>(
    `SELECT hc.curator_id, hc.head_id, m.name AS head_name
       FROM head_curators hc
       JOIN managers m ON m.id = hc.head_id`,
  )
  const out = new Map<string, { headId: string; headName: string }>()
  for (const r of rows) {
    out.set(r.curator_id, { headId: r.head_id, headName: r.head_name })
  }
  return out
}

/**
 * Полная замена состава группы руководителя. Куратор может принадлежать
 * только одному руководителю: выбранные кураторы сначала выводятся из чужих
 * групп (UNIQUE(curator_id) иначе упадёт), затем закрепляются за этим.
 */
export async function setHeadCurators(
  headId: string,
  curatorIds: string[],
): Promise<void> {
  const unique = [...new Set(curatorIds)].filter(Boolean)
  // Санитизация: только существующие кураторы (не менеджеры, не руководители).
  const valid =
    unique.length > 0
      ? await query<{ id: string }>(
          `SELECT id FROM managers WHERE id = ANY($1::uuid[]) AND role = 'curator'`,
          [unique],
        )
      : []
  const ids = valid.map((r) => r.id)

  await withTransaction(async (db) => {
    await db.query(`DELETE FROM head_curators WHERE head_id = $1`, [headId])
    if (ids.length > 0) {
      // Забрать кураторов из чужих групп (переезд между руководителями).
      await db.query(
        `DELETE FROM head_curators WHERE curator_id = ANY($1::uuid[])`,
        [ids],
      )
      await db.query(
        `INSERT INTO head_curators (head_id, curator_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [headId, ids],
      )
    }
  })
}

/** Активные (переданные, не в архиве) лиды всех кураторов руководителя. */
export async function listLeadCardsForHead(
  headId: string,
): Promise<LeadCard[]> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.curator_id IN (
              SELECT curator_id FROM head_curators WHERE head_id = $1
            )
        AND lc.transferred_at IS NOT NULL
        AND lc.archived_at IS NULL
      ORDER BY lc.transferred_at DESC`,
    [headId],
  )
  return rows.map(toLeadCard)
}
