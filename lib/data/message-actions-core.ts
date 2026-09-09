import { revalidatePath } from 'next/cache'
import { enqueueJob } from '@/lib/data'

/**
 * Shared implementation of the three Telegram message context-menu actions
 * (react / delete-for-everyone / edit-own) for BOTH the manager and the curator
 * surfaces. Manager and curator paths are byte-for-byte identical apart from
 * four axes, so they diverge purely through the `MessageActionScope` passed in:
 *
 *   - `resolveDispatch`  — manager: getMessageDispatch (curator_id NULL scope);
 *                          curator: getMessageDispatchForCurator (curator scope)
 *   - the local mutator  — setMessageReaction / markMessageDeleted / editBody
 *                          vs. their *ForCurator twins
 *   - `enqueueManagerId` — manager: the acting session; curator: the channel's
 *                          owning manager (a curator has no Telegram session)
 *   - `revalidate`       — '/app/inbox' vs '/curator/chats'
 *
 * Keeping the bodies here means a change to the synthetic-dialog handling, the
 * provider-id gate, or the enqueue-failure UX can never drift between the two
 * surfaces again (the exact bug the audit flagged).
 */

export interface SimpleResult {
  ok: boolean
  message: string
}

/**
 * The subset of a message dispatch row the shared bodies need. Both
 * getMessageDispatch and getMessageDispatchForCurator already return supersets
 * of this shape.
 */
export interface MessageDispatchLike {
  channelId: string
  channelType: string
  contactHandle: string
  providerMessageId: string | null
  synthetic: boolean
  direction: 'in' | 'out'
}

interface ScopeContext {
  revalidatePath: string
  /**
   * The principal the worker job is enqueued under. Manager acts as itself
   * (session.sub); a curator has no Telegram session, so their wrapper passes
   * the channel's owning manager id (dispatch.managerId).
   */
  enqueueManagerId: string
}

/** Run the shared enqueue + degraded-sync UX used by react/delete/edit. */
async function enqueueWithDegradedSync(
  ctx: ScopeContext,
  dispatch: MessageDispatchLike,
  action: 'react_message' | 'delete_message' | 'edit_message',
  payload: Record<string, unknown>,
  logLabel: string,
  successMessage: string,
  degradedMessage: string,
): Promise<SimpleResult> {
  const enqueued = await enqueueJob({
    channelId: dispatch.channelId,
    managerId: ctx.enqueueManagerId,
    action,
    payload,
  })
    .then(() => true)
    .catch((err) => {
      console.error(logLabel, err)
      return false
    })

  revalidatePath(ctx.revalidatePath)
  // The local write is already persisted (it IS the source of truth), but if the
  // provider job never queued we tell the user sync is delayed rather than
  // reporting a clean success that silently diverges from Telegram.
  if (!enqueued) return { ok: true, message: degradedMessage }
  return { ok: true, message: successMessage }
}

/** Shared body: toggle an emoji reaction (Telegram only). */
export async function reactMessageCore(
  ctx: ScopeContext,
  dispatch: MessageDispatchLike | null,
  emoji: string,
  applyReaction: () => Promise<void>,
  logLabel: string,
): Promise<SimpleResult> {
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Реакции доступны только для Telegram.' }
  }
  // God-created dialog: nothing exists in Telegram to react to — the local row
  // IS the truth, so skip both the provider-id gate and the worker job.
  if (!dispatch.synthetic && !dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  await applyReaction()

  const successMessage = emoji ? 'Реакция добавлена.' : 'Реакция убрана.'
  if (dispatch.synthetic) {
    revalidatePath(ctx.revalidatePath)
    return { ok: true, message: successMessage }
  }

  return enqueueWithDegradedSync(
    ctx,
    dispatch,
    'react_message',
    {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
      emoji,
    },
    logLabel,
    successMessage,
    'Реакция сохранена, синхронизация с Telegram задержана.',
  )
}

/** Shared body: delete a message for everyone (Telegram only). */
export async function deleteMessageCore(
  ctx: ScopeContext,
  dispatch: MessageDispatchLike | null,
  applyDelete: () => Promise<void>,
  logLabel: string,
): Promise<SimpleResult> {
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Удаление доступно только для Telegram.' }
  }
  // God-created dialog: the send never reached Telegram, so there is no provider
  // id and nothing to revoke — a local soft-delete is the whole job.
  if (!dispatch.synthetic && !dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  await applyDelete()

  if (dispatch.synthetic) {
    revalidatePath(ctx.revalidatePath)
    return { ok: true, message: 'Сообщение удалено.' }
  }

  return enqueueWithDegradedSync(
    ctx,
    dispatch,
    'delete_message',
    {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
    },
    logLabel,
    'Сообщение удалено.',
    'Удалено локально, синхронизация с Telegram задержана.',
  )
}

/**
 * Shared body: edit the actor's OWN outgoing message (Telegram only).
 * `applyEdit` returns false when the text was unchanged.
 */
export async function editMessageCore(
  ctx: ScopeContext,
  dispatch: MessageDispatchLike | null,
  text: string,
  applyEdit: () => Promise<boolean>,
  logLabel: string,
): Promise<SimpleResult> {
  if (!dispatch) return { ok: false, message: 'Сообщение не найдено.' }
  if (dispatch.direction !== 'out') {
    return { ok: false, message: 'Можно редактировать только свои сообщения.' }
  }
  if (dispatch.channelType !== 'telegram') {
    return { ok: false, message: 'Редактирование доступно только для Telegram.' }
  }
  if (!dispatch.synthetic && !dispatch.providerMessageId) {
    return { ok: false, message: 'Сообщение ещё не доставлено.' }
  }

  const changed = await applyEdit()
  if (!changed) return { ok: true, message: 'Без изменений.' }

  if (dispatch.synthetic) {
    revalidatePath(ctx.revalidatePath)
    return { ok: true, message: 'Сообщение изменено.' }
  }

  return enqueueWithDegradedSync(
    ctx,
    dispatch,
    'edit_message',
    {
      target: dispatch.contactHandle,
      providerMessageId: dispatch.providerMessageId,
      body: text,
    },
    logLabel,
    'Сообщение изменено.',
    'Изменено локально, синхронизация с Telegram задержана.',
  )
}

export type { ScopeContext }
