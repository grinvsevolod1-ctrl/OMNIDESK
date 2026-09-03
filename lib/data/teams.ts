/**
 * Команды (миграция 150) — единая орг-единица. Руководитель (role = 'head')
 * владеет командой; кураторы и менеджеры продаж входят в неё через
 * managers.team_id. Лид, переданный менеджером, направляется в команду
 * (lead_cards.team_id) и разбирается кураторами вручную (claim).
 *
 * Заменяет прежние head_curators / head_managers: heads.ts переписан поверх
 * этого модуля с сохранением сигнатур, поэтому ACL/аналитика руководителя
 * работают без изменений.
 */
import { query, withTransaction } from '../db'
import { findCuratorsByCity } from './lead-curators'
import { excludeAdminSql, managerColumns, toManager, type ManagerRow } from './shared'
import type { Manager } from '../types'

/** Член команды с числом активных лидов (для карточек управления). */
export interface TeamMember extends Manager {
  activeLeads: number
}

export interface Team {
  id: string
  name: string
  headId: string | null
  headName: string | null
  curators: TeamMember[]
  managers: TeamMember[]
  createdAt: string
}

interface TeamRow {
  id: string
  name: string
  head_id: string | null
  head_name: string | null
  created_at: string | Date
}

/** Число активных (не отказ/слив) лидов куратора — как в findCuratorsByCity. */
const CURATOR_LOAD = `
  (SELECT count(*) FROM lead_cards lc
    WHERE lc.curator_id = m.id
      AND lc.transferred_at IS NOT NULL
      AND (lc.status IS NULL OR lc.status NOT IN ('refused', 'left'))
  )::int`

/** Число не-архивных лидов менеджера продаж. */
const MANAGER_LOAD = `
  (SELECT count(*) FROM lead_cards lc
    WHERE lc.manager_id = m.id AND lc.archived_at IS NULL)::int`

async function membersOfTeams(
  teamIds: string[],
): Promise<Map<string, { curators: TeamMember[]; managers: TeamMember[] }>> {
  const out = new Map<string, { curators: TeamMember[]; managers: TeamMember[] }>()
  for (const id of teamIds) out.set(id, { curators: [], managers: [] })
  if (teamIds.length === 0) return out

  const rows = await query<ManagerRow & { team_id: string; active_leads: number }>(
    `SELECT ${managerColumns('m')}, m.team_id,
            CASE WHEN m.role = 'curator' THEN ${CURATOR_LOAD}
                 ELSE ${MANAGER_LOAD} END AS active_leads
       FROM managers m
      WHERE m.team_id = ANY($1::uuid[])
        AND m.role IN ('curator', 'manager')
      ORDER BY m.name`,
    [teamIds],
  )
  for (const r of rows) {
    const bucket = out.get(r.team_id)
    if (!bucket) continue
    const member: TeamMember = { ...toManager(r), activeLeads: r.active_leads }
    if (r.role === 'curator') bucket.curators.push(member)
    else bucket.managers.push(member)
  }
  return out
}

function toTeam(
  r: TeamRow,
  members: { curators: TeamMember[]; managers: TeamMember[] },
): Team {
  return {
    id: r.id,
    name: r.name,
    headId: r.head_id,
    headName: r.head_name,
    curators: members.curators,
    managers: members.managers,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/** All teams (admin), newest first, with full member rosters. */
export async function listTeams(): Promise<Team[]> {
  const rows = await query<TeamRow>(
    `SELECT t.id, t.name, t.head_id, t.created_at, h.name AS head_name
       FROM teams t
       LEFT JOIN managers h ON h.id = t.head_id
      ORDER BY t.created_at DESC`,
  )
  const members = await membersOfTeams(rows.map((r) => r.id))
  return rows.map((r) =>
    toTeam(r, members.get(r.id) ?? { curators: [], managers: [] }),
  )
}

/** Teams owned by a head. */
export async function listTeamsForHead(headId: string): Promise<Team[]> {
  const rows = await query<TeamRow>(
    `SELECT t.id, t.name, t.head_id, t.created_at, h.name AS head_name
       FROM teams t
       LEFT JOIN managers h ON h.id = t.head_id
      WHERE t.head_id = $1
      ORDER BY t.created_at DESC`,
    [headId],
  )
  const members = await membersOfTeams(rows.map((r) => r.id))
  return rows.map((r) =>
    toTeam(r, members.get(r.id) ?? { curators: [], managers: [] }),
  )
}

export async function getTeamById(teamId: string): Promise<Team | null> {
  const rows = await query<TeamRow>(
    `SELECT t.id, t.name, t.head_id, t.created_at, h.name AS head_name
       FROM teams t
       LEFT JOIN managers h ON h.id = t.head_id
      WHERE t.id = $1 LIMIT 1`,
    [teamId],
  )
  if (!rows[0]) return null
  const members = await membersOfTeams([teamId])
  return toTeam(rows[0], members.get(teamId) ?? { curators: [], managers: [] })
}

/** Команда конкретного участника (куратора/менеджера) или null. */
export async function getManagerTeamId(
  managerId: string,
): Promise<string | null> {
  const rows = await query<{ team_id: string | null }>(
    `SELECT team_id FROM managers WHERE id = $1 LIMIT 1`,
    [managerId],
  )
  return rows[0]?.team_id ?? null
}

/** Id активных кураторов команды. */
export async function listTeamCuratorIds(teamId: string): Promise<string[]> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM managers
      WHERE team_id = $1 AND role = 'curator' AND status = 'active'`,
    [teamId],
  )
  return rows.map((r) => r.id)
}

/**
 * Кому в команде «светится» лид по городу (регион-aware). Берём общий
 * region-aware поиск findCuratorsByCity (единый источник правды сопоставления)
 * и оставляем только кураторов ЭТОЙ команды. Если по городу не совпал никто —
 * лид достаётся ВСЕМ активным кураторам команды, чтобы не потеряться.
 * Возврат: { curatorIds, matchedByCity } — matchedByCity=false означает
 * fallback «вся команда».
 */
export async function resolveTeamPoolTargets(
  teamId: string,
  city: string,
): Promise<{ curatorIds: string[]; matchedByCity: boolean }> {
  const teamCuratorIds = await listTeamCuratorIds(teamId)
  if (teamCuratorIds.length === 0) {
    return { curatorIds: [], matchedByCity: false }
  }
  const teamSet = new Set(teamCuratorIds)
  if (city.trim()) {
    const byCity = await findCuratorsByCity(city).catch(() => [])
    const matched = byCity.map((c) => c.id).filter((id) => teamSet.has(id))
    if (matched.length > 0) return { curatorIds: matched, matchedByCity: true }
  }
  return { curatorIds: teamCuratorIds, matchedByCity: false }
}

export async function createTeam(input: {
  name: string
  headId: string | null
}): Promise<string> {
  const name = input.name.trim()
  if (!name) throw new Error('Укажите название команды.')
  const rows = await query<{ id: string }>(
    `INSERT INTO teams (name, head_id) VALUES ($1, $2) RETURNING id`,
    [name, input.headId],
  )
  return rows[0].id
}

export async function renameTeam(teamId: string, name: string): Promise<void> {
  const clean = name.trim()
  if (!clean) throw new Error('Укажите название команды.')
  await query(`UPDATE teams SET name = $2, updated_at = now() WHERE id = $1`, [
    teamId,
    clean,
  ])
}

/** Удаление команды: участники и лиды освобождаются (ON DELETE SET NULL). */
export async function deleteTeam(teamId: string): Promise<void> {
  await query(`DELETE FROM teams WHERE id = $1`, [teamId])
}

/**
 * Полная замена состава команды. Куратор/менеджер принадлежит только одной
 * команде: выбранные сначала выводятся из своих прежних команд, затем
 * закрепляются за этой. Санитизация — только существующие active-аккаунты
 * нужной роли (админскую identity исключаем).
 */
export async function setTeamMembers(input: {
  teamId: string
  curatorIds: string[]
  managerIds: string[]
}): Promise<void> {
  const curatorIds = [...new Set(input.curatorIds)].filter(Boolean)
  const managerIds = [...new Set(input.managerIds)].filter(Boolean)

  await withTransaction(async (db) => {
    // Освободить прежний состав ЭТОЙ команды.
    await db.query(`UPDATE managers SET team_id = NULL WHERE team_id = $1`, [
      input.teamId,
    ])

    const validCurators =
      curatorIds.length > 0
        ? (
            await db.query<{ id: string }>(
              `SELECT id FROM managers
                WHERE id = ANY($1::uuid[]) AND role = 'curator'`,
              [curatorIds],
            )
          ).rows.map((r) => r.id)
        : []
    const validManagers =
      managerIds.length > 0
        ? (
            await db.query<{ id: string }>(
              `SELECT id FROM managers
                WHERE id = ANY($1::uuid[]) AND role = 'manager'`,
              [managerIds],
            )
          ).rows.map((r) => r.id)
        : []

    const all = [...validCurators, ...validManagers]
    if (all.length > 0) {
      // Переезд из чужих команд + закрепление за этой одним апдейтом.
      await db.query(`UPDATE managers SET team_id = $2 WHERE id = ANY($1::uuid[])`, [
        all,
        input.teamId,
      ])
    }
  })
}

/** Активные кураторы и менеджеры без команды (для секции «Без команды»). */
export async function listUnassignedMembers(): Promise<{
  curators: Manager[]
  managers: Manager[]
}> {
  const rows = await query<ManagerRow>(
    `SELECT ${managerColumns('managers')} FROM managers
      WHERE team_id IS NULL
        AND role IN ('curator', 'manager')
        AND status = 'active'
        ${excludeAdminSql('managers')}
      ORDER BY role, name`,
  )
  const curators: Manager[] = []
  const managers: Manager[] = []
  for (const r of rows) {
    if (r.role === 'curator') curators.push(toManager(r))
    else managers.push(toManager(r))
  }
  return { curators, managers }
}
