'use server'

/**
 * Жизненный цикл лида: архив финальных статусов и возврат в воронку ИИ
 * (миграция 117). Часть распила app/actions/lead-cards.ts.
 */
import { getSession, requireCurator } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  addLeadComment,
  getLeadCardById,
  listArchivedLeadsForCurator,
  setLeadArchived,
} from '@/lib/data/lead-cards'
import { enrollConversationAi } from '@/lib/data/ai-assist'
import { isFinalLeadStatus } from '@/lib/lead-status'
import {
  assertCuratorNotLocked,
  type LeadCardActionResult,
} from './shared'

/** Curator: archived leads of the current curator. */
export async function listMyArchivedLeadsAction() {
  const session = await requireCurator()
  return listArchivedLeadsForCurator(session.sub)
}

/**
 * Архив финального лида / возврат из архива. Доступно менеджеру по кадрам
 * (только свои лиды, с проверкой дисциплины) и админу (любой лид).
 */
export async function setLeadArchivedAction(input: {
  leadCardId: string
  archived: boolean
}): Promise<LeadCardActionResult> {
  const session = await getSession()
  if (!session) return { ok: false, message: 'Не авторизован' }
  if (session.role !== 'admin' && session.role !== 'curator') {
    return { ok: false, message: 'Нет доступа' }
  }
  try {
    if (session.role === 'curator') {
      // Archiving is workspace maintenance — the daily gate still applies.
      await assertCuratorNotLocked(session.sub)
    }
    await setLeadArchived({
      leadCardId: input.leadCardId,
      // Админ действует без проверки владельца; имя — снапшотом в журнал.
      // Корневой админ живёт вне таблицы managers (sub = 'admin') — FK NULL.
      curatorId: session.role === 'curator' ? session.sub : null,
      archived: input.archived,
      actorId:
        session.role === 'admin' && session.sub !== 'admin'
          ? session.sub
          : null,
      actorName:
        session.role === 'admin' ? (session.name ?? 'Администратор') : null,
    })
    return {
      ok: true,
      message: input.archived ? 'Лид перенесён в архив.' : 'Лид возвращён из архива.',
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка архивации'
    return { ok: false, message: msg }
  }
}

/**
 * Return a final lead to the AI funnel: the seller re-enrolls into the
 * original dialog (existing follow-up machinery revives the client), and the
 * card goes to the archive so it leaves the active workspace. Available to
 * the owning curator and to the admin.
 */
export async function returnLeadToFunnelAction(input: {
  leadCardId: string
}): Promise<LeadCardActionResult> {
  const session = await getSession()
  if (!session) throw new Error('Unauthorized')

  const card = await getLeadCardById(input.leadCardId)
  if (!card) return { ok: false, message: 'Лид не найден.' }

  const allowed =
    session.role === 'admin' ||
    (session.role === 'curator' && card.curatorId === session.sub)
  if (!allowed) return { ok: false, message: 'Нет доступа к этому лиду.' }

  if (!isFinalLeadStatus(card.status)) {
    return {
      ok: false,
      message:
        'Вернуть в воронку можно только лид с финальным статусом («Отказался» или «Кинул»).',
    }
  }
  if (!card.conversationId) {
    return {
      ok: false,
      message: 'У этого лида нет привязанного диалога — ИИ некуда возвращаться.',
    }
  }

  try {
    const enrolled = await enrollConversationAi(card.conversationId)
    if (!enrolled) {
      return { ok: false, message: 'Не удалось включить ИИ в диалог.' }
    }
    // The card leaves the active workspace; the trail notes who sent it back.
    await query(
      `UPDATE lead_cards
          SET archived_at = COALESCE(archived_at, now()), updated_at = now()
        WHERE id = $1`,
      [card.id],
    )
    await addLeadComment({
      leadCardId: card.id,
      authorId: session.sub,
      body: 'Лид возвращён в работу ИИ-менеджера (реанимация из финального статуса).',
    }).catch(() => null)

    return {
      ok: true,
      message: `Лид «${card.fullName || 'без имени'}» возвращён в воронку — ИИ снова ведёт диалог.`,
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка возврата в воронку'
    return { ok: false, message: msg }
  }
}
