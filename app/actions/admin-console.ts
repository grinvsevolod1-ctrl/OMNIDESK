'use server'

import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { requireAdmin } from '@/lib/auth'
import {
  deleteChannelById,
  deleteManager,
  deleteProxy,
  getManagerById,
  updateManagerStatus,
} from '@/lib/data'
import { deleteFinanceEntry } from '@/lib/finance'
import {
  SHELL_MODE_COOKIE,
  type AssistantResult,
  type AssistantTurn,
  type PendingConfirmation,
} from '@/lib/admin-console/assistant'
import { runAssistantOnce } from '@/lib/admin-console/run-assistant'
import {
  clearConsoleSession,
  saveConsoleSession,
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
  if (!id) return { ok: false, message: 'Некорректное подтверждение' }

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

/** «Новый диалог»: forget the saved session. */
export async function clearShellSessionAction(): Promise<void> {
  const user = await requireAdmin()
  try {
    await clearConsoleSession(user.sub)
  } catch {
    // Same fail-open contract as save.
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
