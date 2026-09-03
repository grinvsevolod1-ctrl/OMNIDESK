'use server'

/**
 * Команды (миграция 150). Руководитель владеет своими командами и назначает
 * туда ДОСТУПНЫХ ему людей (свободных или уже в его командах). Админ делает то
 * же со ВСЕМИ командами и всеми людьми и видит полную аналитику. Единый набор
 * экшенов используется и админкой (/admin/teams), и панелью руководителя
 * (/head) — гейт внутри каждого экшена.
 */
import { revalidatePath } from 'next/cache'
import { getSession, requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'
import { writeAudit } from '@/lib/data/audit'
import { listHeads } from '@/lib/data/heads'
import {
  createTeam,
  deleteTeam,
  getTeamById,
  listTeams,
  listTeamsForHead,
  listUnassignedMembers,
  renameTeam,
  setTeamMembers,
} from '@/lib/data/teams'
import type { ActionResult } from '@/lib/types'

/** Сессия админа ИЛИ руководителя (обе роли управляют командами). */
async function requireAdminOrHead() {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')
  if (session.role !== 'admin' && session.role !== 'head') {
    throw new Error('Forbidden')
  }
  return session
}

/** Руководитель владеет командой? (админ — всегда true.) */
async function assertOwnsTeam(
  session: { role: string; sub: string },
  teamId: string,
): Promise<void> {
  if (session.role === 'admin') return
  const rows = await query<{ id: string }>(
    `SELECT id FROM teams WHERE id = $1 AND head_id = $2 LIMIT 1`,
    [teamId, session.sub],
  )
  if (!rows[0]) throw new Error('Эта команда вам не принадлежит.')
}

/**
 * Данные экрана управления командами. Админ видит ВСЕ команды + список
 * руководителей (для назначения владельца) + свободных людей. Руководитель —
 * только свои команды + свободных людей (доступный ему пул назначения).
 */
export async function listTeamsAction() {
  const session = await requireAdminOrHead()
  const [teams, unassigned] = await Promise.all([
    session.role === 'admin' ? listTeams() : listTeamsForHead(session.sub),
    listUnassignedMembers(),
  ])
  const heads = session.role === 'admin' ? await listHeads() : []
  return {
    teams,
    unassigned,
    heads,
    viewerRole: session.role,
    viewerId: session.sub,
  }
}

export async function createTeamAction(input: {
  name: string
  /** Владелец-руководитель (только админ вправе задать; head — всегда сам). */
  headId?: string | null
}): Promise<ActionResult> {
  const session = await requireAdminOrHead()
  try {
    const headId =
      session.role === 'head' ? session.sub : (input.headId?.trim() || null)
    const id = await createTeam({ name: input.name, headId })
    if (session.role === 'admin') {
      await writeAudit({
        actorRole: 'admin',
        actorLabel: 'Administrator',
        action: 'team.create',
        entityType: 'team',
        entityId: id,
        details: { name: input.name.trim(), headId },
      })
    }
    revalidatePath('/admin/teams')
    revalidatePath('/head')
    return { ok: true, message: 'Команда создана.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

export async function renameTeamAction(input: {
  teamId: string
  name: string
}): Promise<ActionResult> {
  const session = await requireAdminOrHead()
  try {
    await assertOwnsTeam(session, input.teamId)
    await renameTeam(input.teamId, input.name)
    revalidatePath('/admin/teams')
    revalidatePath('/head')
    return { ok: true, message: 'Название обновлено.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

export async function deleteTeamAction(input: {
  teamId: string
}): Promise<ActionResult> {
  const session = await requireAdminOrHead()
  try {
    await assertOwnsTeam(session, input.teamId)
    await deleteTeam(input.teamId)
    if (session.role === 'admin') {
      await writeAudit({
        actorRole: 'admin',
        actorLabel: 'Administrator',
        action: 'team.delete',
        entityType: 'team',
        entityId: input.teamId,
        details: {},
      })
    }
    revalidatePath('/admin/teams')
    revalidatePath('/head')
    return { ok: true, message: 'Команда удалена.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}

/**
 * Полная замена состава команды. Админ — любые люди. Руководитель — только
 * ДОСТУПНЫЕ ему: свободные (team_id IS NULL) или уже состоящие в ЕГО командах.
 * Чужих (в командах других руководителей) руководитель назначить не может.
 */
export async function setTeamMembersAction(input: {
  teamId: string
  curatorIds: string[]
  managerIds: string[]
}): Promise<ActionResult> {
  const session = await requireAdminOrHead()
  try {
    await assertOwnsTeam(session, input.teamId)

    let curatorIds = input.curatorIds
    let managerIds = input.managerIds

    if (session.role === 'head') {
      // Доступный пул руководителя: свободные ИЛИ уже в его командах.
      const requested = [...curatorIds, ...managerIds].filter(Boolean)
      if (requested.length > 0) {
        const allowed = await query<{ id: string }>(
          `SELECT id FROM managers
            WHERE id = ANY($1::uuid[])
              AND (team_id IS NULL
                   OR team_id IN (SELECT id FROM teams WHERE head_id = $2))`,
          [requested, session.sub],
        )
        const ok = new Set(allowed.rows.map((r) => r.id))
        curatorIds = curatorIds.filter((id) => ok.has(id))
        managerIds = managerIds.filter((id) => ok.has(id))
      }
    }

    await setTeamMembers({
      teamId: input.teamId,
      curatorIds,
      managerIds,
    })
    if (session.role === 'admin') {
      const team = await getTeamById(input.teamId)
      await writeAudit({
        actorRole: 'admin',
        actorLabel: 'Administrator',
        action: 'team.members_update',
        entityType: 'team',
        entityId: input.teamId,
        details: { name: team?.name, curatorIds, managerIds },
      })
    }
    revalidatePath('/admin/teams')
    revalidatePath('/head')
    return { ok: true, message: 'Состав команды обновлён.' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'Ошибка' }
  }
}
