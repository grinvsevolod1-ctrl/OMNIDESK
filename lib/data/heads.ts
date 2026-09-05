/**
 * Руководители (role = 'head', миграция 141) поверх команд (миграция 150).
 *
 * Команда — единая орг-единица: руководитель владеет командой (teams.head_id),
 * кураторы и менеджеры продаж входят в неё через managers.team_id. Прежние
 * join-таблицы head_curators / head_managers удалены миграцией 150; этот модуль
 * переписан поверх teams с СОХРАНЕНИЕМ сигнатур, поэтому вся ACL/аналитика
 * руководителя (app/actions/heads.ts, shared.ts) работает без изменений.
 *
 * Руководитель видит лидов СВОИХ кураторов (переданные, не в архиве), СВОИХ
 * менеджеров (не в архиве) и пул СВОИХ команд (ещё не разобранные лиды). Право
 * на запись контролируется флагом managers.head_can_edit.
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

/**
 * Единственная команда руководителя (legacy-мостик): админский экран
 * /admin/heads исторически назначает руководителю кураторов и менеджеров
 * «одним списком». В модели команд это — состав его основной команды. Берём
 * старейшую команду руководителя, а если её нет — создаём. Новый UB /admin/teams
 * умеет несколько команд на руководителя; здесь работаем с основной.
 */
async function ensureHeadTeam(headId: string): Promise<string> {
  const existing = await query<{ id: string }>(
    `SELECT id FROM teams WHERE head_id = $1 ORDER BY created_at ASC LIMIT 1`,
    [headId],
  )
  if (existing[0]) return existing[0].id
  const name = await query<{ name: string }>(
    `SELECT name FROM managers WHERE id = $1 LIMIT 1`,
    [headId],
  )
  const label = `Команда ${name[0]?.name?.trim() || 'без имени'}`
  const rows = await query<{ id: string }>(
    `INSERT INTO teams (name, head_id) VALUES ($1, $2) RETURNING id`,
    [label, headId],
  )
  return rows[0].id
}

/** SQL-подзапрос: id команд, которыми владеет руководитель. */
const HEAD_TEAMS = `(SELECT id FROM teams WHERE head_id = $1)`

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
       FROM managers m
      WHERE m.role = 'curator'
        AND m.team_id IN ${HEAD_TEAMS}
      ORDER BY m.name`,
    [headId],
  )
  return rows.map((r) => ({ ...toManager(r), activeLeads: r.active_leads }))
}

/** Ids of the head's curators — the base of every head-scoped ACL check. */
export async function listCuratorIdsOfHead(headId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM managers
      WHERE role = 'curator' AND team_id IN ${HEAD_TEAMS}`,
    [headId],
  )
  return rows.map((r) => r.id)
}

/** True when the curator belongs to this head's team(s). */
export async function isCuratorOfHead(
  headId: string,
  curatorId: string | null | undefined,
): Promise<boolean> {
  if (!curatorId) return false
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM managers
      WHERE id = $2 AND role = 'curator' AND team_id IN ${HEAD_TEAMS} LIMIT 1`,
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
    `SELECT m.id AS curator_id, t.head_id, h.name AS head_name
       FROM managers m
       JOIN teams t ON t.id = m.team_id
       JOIN managers h ON h.id = t.head_id
      WHERE m.role = 'curator' AND t.head_id IS NOT NULL`,
  )
  const out = new Map<string, { headId: string; headName: string }>()
  for (const r of rows) {
    out.set(r.curator_id, { headId: r.head_id, headName: r.head_name })
  }
  return out
}

/**
 * Полная замена КУРАТОРСКОГО состава основной команды руководителя.
 * Legacy-мостик для /admin/heads: сохраняет менеджеров команды, заменяет
 * только кураторов. Выбранные кураторы выводятся из чужих команд и
 * закрепляются за этой (managers.team_id — одна команда на человека).
 */
export async function setHeadCurators(
  headId: string,
  curatorIds: string[],
): Promise<void> {
  const unique = [...new Set(curatorIds)].filter(Boolean)
  const teamId = await ensureHeadTeam(headId)
  const valid =
    unique.length > 0
      ? await query<{ id: string }>(
          `SELECT id FROM managers WHERE id = ANY($1::uuid[]) AND role = 'curator'`,
          [unique],
        )
      : []
  const ids = valid.map((r) => r.id)

  await withTransaction(async (db) => {
    // Убрать из этой команды прежних кураторов (менеджеров не трогаем).
    await db.query(
      `UPDATE managers SET team_id = NULL
        WHERE team_id = $1 AND role = 'curator'`,
      [teamId],
    )
    if (ids.length > 0) {
      await db.query(
        `UPDATE managers SET team_id = $2 WHERE id = ANY($1::uuid[])`,
        [ids, teamId],
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
       FROM managers m
      WHERE m.role = 'manager'
        AND m.team_id IN ${HEAD_TEAMS}
      ORDER BY m.name`,
    [headId],
  )
  return rows.map((r) => ({ ...toManager(r), activeLeads: r.active_leads }))
}

/** Ids менеджеров руководителя. */
export async function listManagerIdsOfHead(headId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM managers
      WHERE role = 'manager' AND team_id IN ${HEAD_TEAMS}`,
    [headId],
  )
  return rows.map((r) => r.id)
}

/** True, когда менеджер входит в команду(ы) этого руководителя. */
export async function isManagerOfHead(
  headId: string,
  managerId: string | null | undefined,
): Promise<boolean> {
  if (!managerId) return false
  const rows = await query<{ ok: number }>(
    `SELECT 1 AS ok FROM managers
      WHERE id = $2 AND role = 'manager' AND team_id IN ${HEAD_TEAMS} LIMIT 1`,
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
    `SELECT m.id AS manager_id, t.head_id, h.name AS head_name
       FROM managers m
       JOIN teams t ON t.id = m.team_id
       JOIN managers h ON h.id = t.head_id
      WHERE m.role = 'manager' AND t.head_id IS NOT NULL`,
  )
  const out = new Map<string, { headId: string; headName: string }>()
  for (const r of rows) {
    out.set(r.manager_id, { headId: r.head_id, headName: r.head_name })
  }
  return out
}

/**
 * Полная замена МЕНЕДЖЕРСКОГО состава основной команды руководителя.
 * Legacy-мостик для /admin/heads: сохраняет кураторов, заменяет менеджеров.
 */
export async function setHeadManagers(
  headId: string,
  managerIds: string[],
): Promise<void> {
  const unique = [...new Set(managerIds)].filter(Boolean)
  const teamId = await ensureHeadTeam(headId)
  const valid =
    unique.length > 0
      ? await query<{ id: string }>(
          `SELECT id FROM managers WHERE id = ANY($1::uuid[]) AND role = 'manager'`,
          [unique],
        )
      : []
  const ids = valid.map((r) => r.id)

  await withTransaction(async (db) => {
    await db.query(
      `UPDATE managers SET team_id = NULL
        WHERE team_id = $1 AND role = 'manager'`,
      [teamId],
    )
    if (ids.length > 0) {
      await db.query(
        `UPDATE managers SET team_id = $2 WHERE id = ANY($1::uuid[])`,
        [ids, teamId],
      )
    }
  })
}

/* ---------------------------- Лиды руководителя --------------------------- */

/**
 * Лиды всех команд руководителя одним запросом без дублей:
 *   - карточки его КУРАТОРОВ — только переданные (transferred_at IS NOT NULL);
 *   - карточки его МЕНЕДЖЕРОВ — любые (лиды в воронке до передачи);
 *   - пул его КОМАНД — лиды, направленные в команду, но ещё не разобранные
 *     (team_id команды руководителя, curator_id IS NULL).
 * Все ветки исключают архив. Сортировка — по времени передачи/создания.
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
              SELECT id FROM managers
               WHERE role = 'curator' AND team_id IN ${HEAD_TEAMS}
             )
           AND lc.transferred_at IS NOT NULL)
          OR lc.manager_id IN (
              SELECT id FROM managers
               WHERE role = 'manager' AND team_id IN ${HEAD_TEAMS}
            )
          OR (lc.team_id IN ${HEAD_TEAMS} AND lc.curator_id IS NULL)
        )
      ORDER BY COALESCE(lc.transferred_at, lc.created_at) DESC`,
    [headId],
  )
  return rows.map(toLeadCard)
}

/**
 * Архивные лиды группы руководителя, свежий архив первым. Симметрично
 * listLeadCardsForHead, но archived_at IS NOT NULL: карточки его КУРАТОРОВ
 * (переданные) и его МЕНЕДЖЕРОВ. Пуловые (curator_id IS NULL) в архив не
 * попадают, поэтому эта ветка здесь не нужна. Полная информация карточки —
 * тот же CARD_SELECT, что и для активных, чтобы деталь открывалась целиком.
 */
export async function listArchivedLeadsForHead(
  headId: string,
  limit = 300,
): Promise<LeadCard[]> {
  const rows = await query<LeadCardRow>(
    `SELECT ${CARD_SELECT}
       FROM lead_cards lc
       LEFT JOIN managers m ON m.id = lc.manager_id
       LEFT JOIN managers c ON c.id = lc.curator_id
      WHERE lc.archived_at IS NOT NULL
        AND (
          (lc.curator_id IN (
              SELECT id FROM managers
               WHERE role = 'curator' AND team_id IN ${HEAD_TEAMS}
             )
           AND lc.transferred_at IS NOT NULL)
          OR lc.manager_id IN (
              SELECT id FROM managers
               WHERE role = 'manager' AND team_id IN ${HEAD_TEAMS}
            )
        )
      ORDER BY lc.archived_at DESC
      LIMIT $2`,
    [headId, Math.max(1, Math.min(500, limit))],
  )
  return rows.map(toLeadCard)
}
