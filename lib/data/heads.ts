/**
 * Руководители (role = 'head', миграция 141): учётки в той же таблице
 * managers. Руководитель ведёт группу подчинённых двух видов:
 *   - кураторы (менеджеры по кадрам) — связь в head_curators (миграция 141);
 *   - менеджеры продаж — связь в head_managers (миграция 143).
 * Подчинённый принадлежит максимум одному руководителю. Руководитель видит
 * лидов СВОИХ кураторов (переданные, не в архиве) и СВОИХ менеджеров (не в
 * архиве); право на запись (поля/статусы/комментарии/передача) контролируется
 * флагом managers.head_can_edit.
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

/** Текущее право руководителя (для первого рендера панели /head). */
export async function getHeadCanEdit(headId: string): Promise<boolean> {
  const rows = await query<{ head_can_edit: boolean }>(
    `SELECT head_can_edit FROM managers
      WHERE id = $1 AND role = 'head' LIMIT 1`,
    [headId],
  )
  return !!rows[0]?.head_can_edit
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

/* ------------------------- Менеджеры руководителя ------------------------- */

/** Менеджеры продаж, закреплённые за руководителем (с числом активных лидов). */
export interface HeadManager extends Manager {
  activeLeads: number
}

export async function listManagersOfHead(
  headId: string,
): Promise<HeadManager[]> {
  const rows = await query<ManagerRow & { active_leads: number }>(
    `SELECT ${managerColumns('m')},
            (SELECT COUNT(*)::int FROM lead_cards lc
              WHERE lc.manager_id = m.id
                AND lc.archived_at IS NULL) AS active_leads
       FROM head_managers hm
       JOIN managers m ON m.id = hm.manager_id
      WHERE hm.head_id = $1 AND m.role = 'manager'
      ORDER BY m.name`,
    [headId],
  )
  return rows.map((r) => ({ ...toManager(r), activeLeads: r.active_leads }))
}

/** Ids менеджеров руководителя. */
export async function listManagerIdsOfHead(headId: string): Promise<string[]> {
  const rows = await query<{ manager_id: string }>(
    `SELECT manager_id FROM head_managers WHERE head_id = $1`,
    [headId],
  )
  return rows.map((r) => r.manager_id)
}

/** True, когда менеджер входит в группу этого руководителя. */
export async function isManagerOfHead(
  headId: string,
  managerId: string | null | undefined,
): Promise<boolean> {
  if (!managerId) return false
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM head_managers
      WHERE head_id = $1 AND manager_id = $2 LIMIT 1`,
    [headId, managerId],
  )
  return !!rows[0]
}

/** Который руководитель закреплён за менеджером (для админ-таблицы). */
export async function mapManagerHeads(): Promise<
  Map<string, { headId: string; headName: string }>
> {
  const rows = await query<{
    manager_id: string
    head_id: string
    head_name: string
  }>(
    `SELECT hm.manager_id, hm.head_id, m.name AS head_name
       FROM head_managers hm
       JOIN managers m ON m.id = hm.head_id`,
  )
  const out = new Map<string, { headId: string; headName: string }>()
  for (const r of rows) {
    out.set(r.manager_id, { headId: r.head_id, headName: r.head_name })
  }
  return out
}

/**
 * Полная замена состава менеджеров группы. Менеджер принадлежит только одному
 * руководителю: выбранные сначала выводятся из чужих групп (UNIQUE(manager_id)
 * иначе упадёт), затем закрепляются за этим. Полный аналог setHeadCurators.
 */
export async function setHeadManagers(
  headId: string,
  managerIds: string[],
): Promise<void> {
  const unique = [...new Set(managerIds)].filter(Boolean)
  // Санитизация: только существующие менеджеры продаж (не кураторы/руководители).
  const valid =
    unique.length > 0
      ? await query<{ id: string }>(
          `SELECT id FROM managers WHERE id = ANY($1::uuid[]) AND role = 'manager'`,
          [unique],
        )
      : []
  const ids = valid.map((r) => r.id)

  await withTransaction(async (db) => {
    await db.query(`DELETE FROM head_managers WHERE head_id = $1`, [headId])
    if (ids.length > 0) {
      // Забрать менеджеров из чужих групп (переезд между руководителями).
      await db.query(
        `DELETE FROM head_managers WHERE manager_id = ANY($1::uuid[])`,
        [ids],
      )
      await db.query(
        `INSERT INTO head_managers (head_id, manager_id)
         SELECT $1, unnest($2::uuid[])
         ON CONFLICT DO NOTHING`,
        [headId, ids],
      )
    }
  })
}

/* ---------------------------- Лиды руководителя --------------------------- */

/**
 * Лиды всей группы руководителя одним запросом без дублей:
 *   - карточки его КУРАТОРОВ — только переданные (transferred_at IS NOT NULL);
 *   - карточки его МЕНЕДЖЕРОВ — любые (лиды в воронке до передачи).
 * Обе ветки исключают архив. Сортировка — по времени передачи, а для
 * ещё не переданных менеджерских лидов по времени создания.
 */
export async function listLeadCardsForHead(
  headId: string,
): Promise<LeadCard[]> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.archived_at IS NULL
        AND (
          (lc.curator_id IN (
                SELECT curator_id FROM head_curators WHERE head_id = $1
              )
           AND lc.transferred_at IS NOT NULL)
          OR
          lc.manager_id IN (
            SELECT manager_id FROM head_managers WHERE head_id = $1
          )
        )
      ORDER BY COALESCE(lc.transferred_at, lc.created_at) DESC`,
    [headId],
  )
  return rows.map(toLeadCard)
}
