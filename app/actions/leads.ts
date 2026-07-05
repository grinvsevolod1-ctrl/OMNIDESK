'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  dismissReplyReminder,
  getConversation,
  listConversationsByStatus,
  listMessages,
  setConversationMuted,
  setConversationStatus,
} from '@/lib/data'
import {
  LEAD_STATUS_META,
  NOT_LIQUID_REASON_META,
  type Conversation,
  type LeadStatus,
  type Message,
  type NotLiquidReason,
} from '@/lib/types'

export interface SimpleResult {
  ok: boolean
  message: string
}

/**
 * Manager: list own conversations in a given status bucket (and optional «Не
 * ликвид» reason) for the dashboard status board drill-down. Manager-scoped.
 */
export async function listLeadsByStatusAction(
  status: LeadStatus,
  reason?: NotLiquidReason | null,
): Promise<Conversation[]> {
  const session = await requireManager()
  return listConversationsByStatus(session.sub, status, reason ?? undefined)
}

export interface LeadTranscript {
  conversation: Conversation | null
  messages: Message[]
}

/**
 * Manager: read the full transcript of one of OWN conversations (for the
 * dashboard status board modal). Scoped to the calling manager.
 */
export async function getLeadTranscriptAction(
  conversationId: string,
): Promise<LeadTranscript> {
  const session = await requireManager()
  if (!conversationId) return { conversation: null, messages: [] }
  const [conversation, messages] = await Promise.all([
    getConversation(conversationId, session.sub),
    listMessages(conversationId, session.sub),
  ])
  return { conversation, messages }
}

/**
 * Manager: pin a lead's status, or pass 'auto' to clear the manual override and
 * fall back to the default («Отписок»). For «Не ликвид» an optional reason
 * sub-status (geo / under18 / na / trash) is stored alongside. Scoped to the
 * owning manager.
 */
export async function setLeadStatusAction(
  conversationId: string,
  status: LeadStatus | 'auto',
  reason?: NotLiquidReason | null,
): Promise<SimpleResult> {
  const session = await requireManager()

  const next: LeadStatus | null = status === 'auto' ? null : status
  if (next !== null && !(next in LEAD_STATUS_META)) {
    return { ok: false, message: 'Неизвестный статус.' }
  }
  const detail =
    next === 'not_liquid' && reason && reason in NOT_LIQUID_REASON_META
      ? reason
      : null

  const ok = await setConversationStatus(
    conversationId,
    session.sub,
    next,
    detail,
  )
  if (!ok) return { ok: false, message: 'Диалог не найден.' }

  revalidatePath('/app/inbox')
  revalidatePath('/app')
  return { ok: true, message: 'Статус обновлён.' }
}

/**
 * Manager: dismiss (or restore) the "awaiting reply" state for a conversation,
 * for threads that don't actually need an answer. Scoped to the owning manager.
 */
export async function dismissReplyReminderAction(
  conversationId: string,
  clear = false,
): Promise<SimpleResult> {
  const session = await requireManager()

  const ok = await dismissReplyReminder(conversationId, session.sub, clear)
  if (!ok) return { ok: false, message: 'Диалог не найден.' }

  revalidatePath('/app/inbox')
  revalidatePath('/app')
  return {
    ok: true,
    message: clear ? 'Снова ждёт ответа.' : 'Убрано из ожидающих ответа.',
  }
}

/**
 * Manager: mute (silence) or unmute a conversation — used to shut up abusive or
 * irrelevant contacts without deleting the thread. Scoped to the owning manager.
 */
export async function setConversationMutedAction(
  conversationId: string,
  muted: boolean,
): Promise<SimpleResult> {
  const session = await requireManager()

  const ok = await setConversationMuted(conversationId, session.sub, muted)
  if (!ok) return { ok: false, message: 'Диалог не найден.' }

  revalidatePath('/app/inbox')
  revalidatePath('/app')
  return {
    ok: true,
    message: muted
      ? 'Контакт заглушён — уведомления скрыты.'
      : 'Звук контакта включён.',
  }
}
