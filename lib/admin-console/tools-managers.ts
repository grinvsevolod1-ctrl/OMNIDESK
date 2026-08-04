import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createManager,
  getManagerById,
  listManagers,
  updateManagerStatus,
} from '@/lib/data'
import { hashPassword } from '@/lib/auth'
import { truncate, type RunState } from './run-state'

/**
 * Manager administration. Deleting and blocking are GUARDED: the tool records
 * a pending confirmation instead of applying. Passwords are NEVER routed
 * through the model — createManager returns credentials only to the UI layer.
 */
export function managerTools(state: RunState) {
  return {
    list_managers: tool({
      description:
        'Список менеджеров: имя, email, статус (active/blocked). Вызывай перед любым действием над менеджером, чтобы получить точный id.',
      inputSchema: z.object({}),
      execute: async () => {
        const managers = await listManagers()
        const rows = managers.map((m) => ({
          id: m.id,
          name: m.name,
          email: m.email,
          status: m.status,
        }))
        state.views.push({ kind: 'managers', title: 'Менеджеры', payload: rows })
        return rows
      },
    }),

    create_manager: tool({
      description:
        'Создать менеджера. Пароль генерируется системой и показывается админу в интерфейсе — НЕ проси пароль и не выдумывай его.',
      inputSchema: z.object({
        name: z.string().min(1).max(120),
        email: z.string().email(),
      }),
      execute: async ({ name, email }) => {
        // System-generated password: never passes through the model.
        const password = Array.from(
          crypto.getRandomValues(new Uint8Array(9)),
          (b) => 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789'[b % 55],
        ).join('')
        const manager = await createManager({
          name,
          email,
          passwordHash: await hashPassword(password),
        })
        state.actions.push({
          kind: 'manager',
          label: `Создал менеджера ${truncate(name, 40)}`,
        })
        // Credentials surface through a dedicated view, not the model reply.
        state.views.push({
          kind: 'managers',
          title: 'Новый менеджер (пароль показан один раз)',
          payload: [
            {
              id: manager.id,
              name: manager.name,
              email: manager.email,
              status: manager.status,
              tempPassword: password,
            },
          ],
        })
        return { ok: true, id: manager.id, credentialsShownInUi: true }
      },
    }),

    unblock_manager: tool({
      description: 'Разблокировать менеджера (вернуть статус active).',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const m = await getManagerById(id)
        if (!m) return { ok: false, message: 'Менеджер не найден' }
        await updateManagerStatus(id, 'active')
        state.actions.push({
          kind: 'manager',
          label: `Разблокировал ${truncate(m.name, 40)}`,
        })
        return { ok: true }
      },
    }),

    block_manager: tool({
      description:
        'Заблокировать менеджера (он потеряет доступ к панели). ОПАСНО: не применяется сразу — вернёт needsConfirmation, попроси админа подтвердить кнопкой.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const m = await getManagerById(id)
        if (!m) return { ok: false, message: 'Менеджер не найден' }
        state.pending = {
          kind: 'block_manager',
          label: `Заблокировать ${m.name}`,
          detail: `Менеджер ${m.name} (${m.email}) потеряет доступ к панели, его диалоги останутся.`,
          payload: { id },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),

    block_managers: tool({
      description:
        'Заблокировать НЕСКОЛЬКИХ менеджеров разом («заблокируй всех кроме X» — сначала возьми ids из list_managers и исключи нужных). ОПАСНО: не применяется сразу — вернёт needsConfirmation.',
      inputSchema: z.object({
        ids: z.array(z.string().min(1)).min(1).max(100),
      }),
      execute: async ({ ids }) => {
        const names: string[] = []
        for (const id of ids) {
          const m = await getManagerById(id)
          if (m && m.status === 'active') names.push(m.name)
        }
        if (names.length === 0)
          return { ok: false, message: 'Активных менеджеров среди указанных нет' }
        state.pending = {
          kind: 'block_managers',
          label: `Заблокировать менеджеров: ${names.length}`,
          detail: `Доступ к панели потеряют: ${truncate(names.join(', '), 300)}. Их диалоги останутся.`,
          payload: { ids },
        }
        return { ok: true, needsConfirmation: true, count: names.length }
      },
    }),

    delete_manager: tool({
      description:
        'Удалить менеджера НАВСЕГДА вместе с его каналами. ОПАСНО: не применяется сразу — вернёт needsConfirmation, попроси админа подтвердить кнопкой.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const m = await getManagerById(id)
        if (!m) return { ok: false, message: 'Менеджер не найден' }
        state.pending = {
          kind: 'delete_manager',
          label: `Удалить менеджера ${m.name}`,
          detail: `Безвозвратно: аккаунт ${m.email}, его каналы и назначения будут удалены.`,
          payload: { id },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),
  }
}
