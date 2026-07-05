'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  createQuickReply,
  deleteQuickReply,
  listQuickReplies,
  reorderQuickReplies,
  updateQuickReply,
} from '@/lib/data'
import type { QuickReply } from '@/lib/types'

export interface QuickReplyResult {
  ok: boolean
  message: string
  reply?: QuickReply
}

const MAX_TITLE = 80
const MAX_BODY = 2000

function clean(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Manager: list own quick replies. */
export async function listQuickRepliesAction(): Promise<QuickReply[]> {
  const session = await requireManager()
  return listQuickReplies(session.sub)
}

/** Manager: create a quick reply. Body is required; title is optional. */
export async function createQuickReplyAction(
  title: string,
  body: string,
): Promise<QuickReplyResult> {
  const session = await requireManager()
  const t = clean(title, MAX_TITLE)
  const b = clean(body, MAX_BODY)
  if (!b) return { ok: false, message: 'Введите текст автоответа.' }

  const reply = await createQuickReply(session.sub, t, b)
  if (!reply) return { ok: false, message: 'Не удалось создать автоответ.' }

  revalidatePath('/app/quick-replies')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Автоответ создан.', reply }
}

/** Manager: update an own quick reply. */
export async function updateQuickReplyAction(
  id: string,
  title: string,
  body: string,
): Promise<QuickReplyResult> {
  const session = await requireManager()
  const t = clean(title, MAX_TITLE)
  const b = clean(body, MAX_BODY)
  if (!b) return { ok: false, message: 'Введите текст автоответа.' }

  const ok = await updateQuickReply(id, session.sub, t, b)
  if (!ok) return { ok: false, message: 'Автоответ не найден.' }

  revalidatePath('/app/quick-replies')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Автоответ обновлён.' }
}

/** Manager: delete an own quick reply. */
export async function deleteQuickReplyAction(
  id: string,
): Promise<QuickReplyResult> {
  const session = await requireManager()
  const ok = await deleteQuickReply(id, session.sub)
  if (!ok) return { ok: false, message: 'Автоответ не найден.' }

  revalidatePath('/app/quick-replies')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Автоответ удалён.' }
}

/** Manager: persist a new ordering for own quick replies. */
export async function reorderQuickRepliesAction(
  orderedIds: string[],
): Promise<QuickReplyResult> {
  const session = await requireManager()
  if (!Array.isArray(orderedIds)) {
    return { ok: false, message: 'Некорректный порядок.' }
  }
  await reorderQuickReplies(session.sub, orderedIds)
  revalidatePath('/app/quick-replies')
  revalidatePath('/app/inbox')
  return { ok: true, message: 'Порядок сохранён.' }
}
