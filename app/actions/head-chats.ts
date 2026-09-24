'use server'

import { requireHead } from '@/lib/auth'
import {
  listMessagesBeforeForHead,
  listMessagesForHead,
} from '@/lib/data/head-conversations'
import type { Message } from '@/lib/types'

/**
 * Раздел «Диалоги» руководителя (/head/chats) — ТОЛЬКО ЧТЕНИЕ. Здесь ровно
 * два лоадера истории для общего ядра инбокса (`useThreadHistory` +
 * realtime-догрузка открытого треда); экшенов отправки/правки/удаления/
 * «прочитано» у руководителя нет по продуктовому решению этапа 1. Скоуп —
 * кураторы его команд (см. lib/data/head-conversations).
 */

/** Свежий срез холодного треда (вне SSR-предзагрузки). */
export async function loadHeadThreadMessagesAction(
  conversationId: string,
): Promise<{ ok: boolean; messages: Message[] }> {
  const session = await requireHead()
  if (!conversationId) return { ok: false, messages: [] }
  const messages = await listMessagesForHead(conversationId, session.sub)
  return { ok: true, messages }
}

/** Догрузка более старой истории (пагинация вверх). */
export async function loadOlderHeadMessagesAction(
  conversationId: string,
  before: string,
): Promise<{ ok: boolean; messages: Message[]; hasMore: boolean }> {
  const session = await requireHead()
  if (!conversationId || !before) {
    return { ok: false, messages: [], hasMore: false }
  }
  const PAGE = 100
  const messages = await listMessagesBeforeForHead(
    conversationId,
    session.sub,
    before,
    PAGE,
  )
  return { ok: true, messages, hasMore: messages.length >= PAGE }
}
