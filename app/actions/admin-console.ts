'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { requireAdmin } from '@/lib/auth'
import {
  addMessage,
  adminReassignConversations,
  deleteChannelById,
  deleteManager,
  deleteProxy,
  enqueueJob,
  getChannelById,
  getConversationAdmin,
  getManagerById,
  listConversationIdsForManager,
  reassignChannelManager,
  updateManagerStatus,
} from '@/lib/data'
import { removeDirective } from '@/lib/data/ai-directives'
import { deleteKnowledge } from '@/lib/data/ai-assist'
import { deleteFinanceEntry } from '@/lib/finance'
import {
  SHELL_MODE_COOKIE,
  type AssistantResult,
  type AssistantTurn,
  type PendingConfirmation,
} from '@/lib/admin-console/assistant'
import { runAssistantOnce } from '@/lib/admin-console/run-assistant'
import {
  archiveConsoleSession,
  clearConsoleSession,
  listConsoleSessionArchive,
  restoreConsoleSession,
  saveConsoleSession,
  type ConsoleSessionArchiveItem,
} from '@/lib/data/console-shell'

/**
 * Server actions for the OMNIDESK OS shell: the non-streaming assistant path,
 * the guarded-action confirmation executor, and the classic/OS mode toggle.
 * All admin-only.
 */

/** One-shot assistant turn (fallback path when SSE is unavailable). */
export async function runShellAssistantAction(
  history: AssistantTurn[],
): Promise<AssistantResult> {
  const user = await requireAdmin()
  return runAssistantOnce(history, user.sub)
}

/**
 * Execute a guarded action the admin explicitly confirmed in the UI. The
 * pending payload is re-validated here — the client is never trusted to name
 * arbitrary operations.
 */
export async function confirmShellPendingAction(
  pending: PendingConfirmation,
): Promise<{ ok: boolean; message: string }> {
  await requireAdmin()
  const id = typeof pending?.payload?.id === 'string' ? pending.payload.id : ''
  // Kinds that identify their targets through richer payloads, not a single `id`.
  const NO_SINGLE_ID = new Set([
    'reassign_dialogs',
    'send_message',
    'block_managers',
  ])
  if (!id && !NO_SINGLE_ID.has(pending?.kind))
    return { ok: false, message: 'Некорректное подтверждение' }

  try {
    switch (pending.kind) {
      case 'block_manager': {
        const m = await getManagerById(id)
        if (!m) return { ok: false, message: 'Менеджер не найден' }
        await updateManagerStatus(id, 'blocked')
        revalidatePath('/admin/managers')
        return { ok: true, message: `Менеджер ${m.name} заблокирован` }
      }
      case 'delete_manager': {
        const m = await getManagerById(id)
        if (!m) return { ok: false, message: 'Менеджер не найден' }
        await deleteManager(id)
        revalidatePath('/admin/managers')
        revalidatePath('/admin')
        return { ok: true, message: `Менеджер ${m.name} удалён` }
      }
      case 'delete_channel': {
        await deleteChannelById(id)
        revalidatePath('/admin/accounts')
        revalidatePath('/admin')
        return { ok: true, message: 'Канал удалён' }
      }
      case 'reassign_channel': {
        // managerId: string = reassign, null = unassign. Re-validated here —
        // the pending payload from the client is never trusted blindly.
        const rawManagerId = pending.payload?.managerId
        const managerId =
          typeof rawManagerId === 'string' && rawManagerId ? rawManagerId : null
        const ch = await getChannelById(id)
        if (!ch) return { ok: false, message: 'Канал не найден' }
        let managerName: string | null = null
        if (managerId) {
          const m = await getManagerById(managerId)
          if (!m) return { ok: false, message: 'Менеджер не найден' }
          if (m.status === 'blocked')
            return { ok: false, message: `Менеджер ${m.name} заблокирован` }
          managerName = m.name
        }
        await reassignChannelManager(id, managerId)
        revalidatePath('/admin/accounts')
        revalidatePath('/admin/channels')
        revalidatePath('/admin')
        return {
          ok: true,
          message: managerName
            ? `Канал ${ch.name} передан менеджеру ${managerName}`
            : `Канал ${ch.name} снят с менеджера`,
        }
      }
      case 'reassign_dialogs': {
        // Re-validate everything: the payload crossed the client round-trip.
        const toManagerId =
          typeof pending.payload?.toManagerId === 'string'
            ? pending.payload.toManagerId
            : ''
        if (!toManagerId)
          return { ok: false, message: 'Некорректное подтверждение' }
        const to = await getManagerById(toManagerId)
        if (!to) return { ok: false, message: 'Целевой менеджер не найден' }
        if (to.status !== 'active')
          return { ok: false, message: `Менеджер ${to.name} заблокирован` }

        const fromManagerId =
          typeof pending.payload?.fromManagerId === 'string'
            ? pending.payload.fromManagerId
            : null
        let conversationIds: string[]
        if (fromManagerId) {
          // Resolve the CURRENT dialog list at execution time, not proposal
          // time — dialogs created in between are included, deleted ones not.
          conversationIds = await listConversationIdsForManager(fromManagerId)
        } else {
          conversationIds = Array.isArray(pending.payload?.conversationIds)
            ? (pending.payload.conversationIds as unknown[]).filter(
                (v): v is string => typeof v === 'string',
              )
            : []
        }
        if (conversationIds.length === 0)
          return { ok: false, message: 'Нет диалогов для передачи' }

        const moved = await adminReassignConversations({
          conversationIds,
          toManagerId,
          note: 'OMNIDESK OS: массовая передача диалогов',
        })
        revalidatePath('/admin')
        return {
          ok: moved > 0,
          message:
            moved > 0
              ? `Передано диалогов: ${moved} → ${to.name}`
              : 'Диалоги уже принадлежат этому менеджеру',
        }
      }
      case 'send_message': {
        // Re-validate everything server-side: the payload crossed the client.
        const conversationId =
          typeof pending.payload?.conversationId === 'string'
            ? pending.payload.conversationId
            : ''
        const body =
          typeof pending.payload?.body === 'string'
            ? pending.payload.body.trim().slice(0, 2000)
            : ''
        if (!conversationId || !body)
          return { ok: false, message: 'Некорректное подтверждение' }
        const conv = await getConversationAdmin(conversationId)
        if (!conv) return { ok: false, message: 'Диалог не найден' }
        if (!conv.managerId)
          return { ok: false, message: 'У диалога нет менеджера-владельца' }
        // Persisted as an ordinary manager reply (byAi=false => AI-lead
        // pauses and the thread is marked handed to a human — an admin
        // stepping in IS a human takeover).
        const msg = await addMessage({
          conversationId,
          managerId: conv.managerId,
          body,
          author: conv.managerName ?? 'Менеджер',
        })
        if (!msg) return { ok: false, message: 'Не удалось сохранить сообщение' }
        await enqueueJob({
          channelId: conv.channelId,
          managerId: conv.managerId,
          action: 'send_message',
          payload: {
            target: conv.contactHandle,
            body,
            messageId: msg.id,
          },
        }).catch((err) => {
          console.error('[shell] failed to enqueue send job:', err)
        })
        return {
          ok: true,
          message: `Сообщение отправлено: ${conv.contactName || conv.contactHandle}`,
        }
      }
      case 'block_managers': {
        const ids = Array.isArray(pending.payload?.ids)
          ? (pending.payload.ids as unknown[]).filter(
              (v): v is string => typeof v === 'string',
            )
          : []
        if (ids.length === 0)
          return { ok: false, message: 'Некорректное подтверждение' }
        let blocked = 0
        for (const managerId of ids.slice(0, 100)) {
          const m = await getManagerById(managerId)
          if (!m || m.status !== 'active') continue
          await updateManagerStatus(managerId, 'blocked')
          blocked += 1
        }
        revalidatePath('/admin/managers')
        return {
          ok: blocked > 0,
          message:
            blocked > 0
              ? `Заблокировано менеджеров: ${blocked}`
              : 'Никто не заблокирован (уже неактивны?)',
        }
      }
      case 'delete_directive': {
        const removed = await removeDirective(id)
        if (!removed) return { ok: false, message: 'Директива не найдена' }
        revalidatePath('/admin/ai')
        return { ok: true, message: 'Директива удалена' }
      }
      case 'delete_knowledge': {
        await deleteKnowledge(id)
        revalidatePath('/admin/ai')
        return { ok: true, message: 'Статья удалена из базы знаний' }
      }
      case 'delete_proxy': {
        await deleteProxy(id)
        revalidatePath('/admin/proxies')
        return { ok: true, message: 'Прокси удалён' }
      }
      case 'delete_finance_entry': {
        await deleteFinanceEntry(id)
        revalidatePath('/admin/finance')
        return { ok: true, message: 'Запись удалена' }
      }
      default:
        return { ok: false, message: 'Неизвестное действие' }
    }
  } catch {
    return { ok: false, message: 'Не удалось выполнить действие' }
  }
}

/**
 * Persist the running dialog so a reload or another browser keeps context.
 * Fire-and-forget from the client; failures are silent (memory is a nicety).
 */
export async function saveShellSessionAction(
  turns: AssistantTurn[],
): Promise<void> {
  const user = await requireAdmin()
  try {
    await saveConsoleSession(user.sub, turns)
  } catch {
    // Never let persistence break the dialog itself.
  }
}

/** «Новый диалог»: archive the current dialog (restorable), then clear. */
export async function clearShellSessionAction(): Promise<void> {
  const user = await requireAdmin()
  try {
    await archiveConsoleSession(user.sub)
    await clearConsoleSession(user.sub)
  } catch {
    // Same fail-open contract as save.
  }
}

/** Archived shell dialogs, newest first (for the «История» panel). */
export async function listShellHistoryAction(): Promise<
  ConsoleSessionArchiveItem[]
> {
  const user = await requireAdmin()
  return listConsoleSessionArchive(user.sub)
}

/**
 * Restore an archived dialog as the live session (the current one is archived
 * first — nothing is lost). Returns the turns for the client to render.
 */
export async function restoreShellSessionAction(
  archiveId: string,
): Promise<AssistantTurn[] | null> {
  const user = await requireAdmin()
  try {
    return await restoreConsoleSession(user.sub, archiveId)
  } catch {
    return null
  }
}

/** Toggle between the OS shell (default) and the classic tab UI. */
export async function setShellModeAction(enabled: boolean): Promise<void> {
  await requireAdmin()
  const jar = await cookies()
  // ALWAYS write an explicit value on BOTH paths. The previous version set
  // '0' with path=/admin but deleted with the default path=/ — a mismatch
  // the browser ignores, so «Включить OMNIDESK OS» could never clear the
  // opt-out cookie and the classic UI kept coming back after reload.
  const value = enabled ? '1' : '0'
  const base = {
    httpOnly: true,
    sameSite: 'lax' as const,
    maxAge: 60 * 60 * 24 * 365,
  }
  jar.set(SHELL_MODE_COOKIE, value, { ...base, path: '/' })
  // Overwrite the legacy /admin-scoped cookie so it cannot shadow the new one.
  jar.set(SHELL_MODE_COOKIE, value, { ...base, path: '/admin' })
  revalidatePath('/admin')
}
