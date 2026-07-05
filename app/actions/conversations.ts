'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  listTransferTargets,
  transferConversation,
  type TransferTarget,
} from '@/lib/data'

export interface SimpleResult {
  ok: boolean
  message: string
}

/**
 * Manager: list colleagues a conversation can be handed off to (active managers
 * except the caller). Used to populate the transfer picker in the inbox.
 */
export async function listTransferTargetsAction(): Promise<TransferTarget[]> {
  const session = await requireManager()
  return listTransferTargets(session.sub)
}

/**
 * Manager: hand one of OWN conversations off to another manager, with an
 * optional handover note. Scoped to the owning manager, so a thread you don't
 * own can't be transferred.
 */
export async function transferConversationAction(
  conversationId: string,
  toManagerId: string,
  note?: string,
): Promise<SimpleResult> {
  const session = await requireManager()
  if (!conversationId || !toManagerId) {
    return { ok: false, message: 'Выберите менеджера для передачи.' }
  }
  if (toManagerId === session.sub) {
    return { ok: false, message: 'Нельзя передать диалог самому себе.' }
  }

  const ok = await transferConversation({
    conversationId,
    fromManagerId: session.sub,
    toManagerId,
    note,
  })
  if (!ok) {
    return {
      ok: false,
      message: 'Не удалось передать диалог. Обновите страницу и попробуйте снова.',
    }
  }

  revalidatePath('/app/inbox')
  revalidatePath('/app')
  return { ok: true, message: 'Диалог передан менеджеру.' }
}
