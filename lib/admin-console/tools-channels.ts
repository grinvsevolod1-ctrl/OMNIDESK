import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  getChannelById,
  getManagerById,
  getProxyAnalytics,
  getProxyById,
  listAdminChannels,
  listAllProxies,
} from '@/lib/data'
import { getDictionaries } from '@/lib/data/dictionaries'
import { truncate, type RunState } from './run-state'

/**
 * Channels (messenger accounts) + proxies. Read tools ground the model on the
 * live fleet; destructive actions are GUARDED (pending confirmation).
 * Session strings, proxy credentials and other secrets are NEVER returned.
 */
export function channelTools(state: RunState) {
  return {
    list_channels: tool({
      description:
        'Список всех каналов/аккаунтов мессенджеров: тип, имя, статус, менеджер. Секреты (сессии) не возвращаются. Вызывай перед действиями над каналом.',
      inputSchema: z.object({}),
      execute: async () => {
        const [channels, dict] = await Promise.all([
          listAdminChannels(),
          getDictionaries(),
        ])
        const rows = channels.map((c) => ({
          id: c.id,
          type: c.type,
          typeLabel: dict.channelTypes[c.type] ?? c.type,
          name: c.name,
          status: c.status,
          statusLabel: dict.accountStatuses[c.status] ?? c.status,
          managerName: c.managerName ?? null,
        }))
        state.views.push({ kind: 'channels', title: 'Каналы', payload: rows })
        return rows
      },
    }),

    delete_channel: tool({
      description:
        'Удалить канал/аккаунт. ОПАСНО: вернёт needsConfirmation — попроси админа подтвердить кнопкой.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const ch = await getChannelById(id)
        if (!ch) return { ok: false, message: 'Канал не найден' }
        state.pending = {
          kind: 'delete_channel',
          label: `Удалить канал ${truncate(ch.name, 40)}`,
          detail:
            'Канал будет отключён и удалён; история диалогов останется в базе.',
          payload: { id },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),

    reassign_channel: tool({
      description:
        'Переназначить канал другому менеджеру (или снять привязку, передав managerId: null). Сессия и история диалогов сохраняются. Вернёт needsConfirmation — попроси админа подтвердить кнопкой. Если менеджер назван по имени — сначала найди его id через list_managers.',
      inputSchema: z.object({
        id: z.string().min(1).describe('id канала (см. list_channels)'),
        managerId: z
          .string()
          .min(1)
          .nullable()
          .describe('id нового менеджера или null, чтобы снять привязку'),
      }),
      execute: async ({ id, managerId }) => {
        const ch = await getChannelById(id)
        if (!ch) return { ok: false, message: 'Канал не найден' }
        let managerName: string | null = null
        if (managerId) {
          const m = await getManagerById(managerId)
          if (!m)
            return {
              ok: false,
              message:
                'Менеджер не найден — проверь id через list_managers',
            }
          if (m.status === 'blocked')
            return {
              ok: false,
              message: `Менеджер ${m.name} заблокирован — сначала разблокируй его`,
            }
          managerName = m.name
        }
        state.pending = {
          kind: 'reassign_channel',
          label: managerName
            ? `Передать канал ${truncate(ch.name, 30)} менеджеру ${truncate(managerName, 30)}`
            : `Снять канал ${truncate(ch.name, 30)} с менеджера`,
          detail: managerName
            ? 'Канал вместе с активной сессией и историей диалогов перейдёт к новому менеджеру.'
            : 'Канал останется без менеджера: новые лиды по нему не будут распределяться.',
          payload: { id, managerId },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),

    list_proxies: tool({
      description:
        'Список прокси и их здоровье (статусы, привязки к менеджерам). Адреса показываются, пароли прокси — нет.',
      inputSchema: z.object({}),
      execute: async () => {
        const [proxies, analytics, dict] = await Promise.all([
          listAllProxies(),
          getProxyAnalytics(),
          getDictionaries(),
        ])
        const rows = proxies.map((p) => ({
          id: p.id,
          label: p.label ?? p.host,
          host: p.host,
          status: p.status,
          statusLabel: dict.proxyStatuses[p.status] ?? p.status,
          managerId: p.managerId ?? null,
        }))
        state.views.push({
          kind: 'proxies',
          title: 'Прокси',
          payload: { rows, analytics },
        })
        return { rows, analytics }
      },
    }),

    delete_proxy: tool({
      description:
        'Удалить прокси. ОПАСНО: вернёт needsConfirmation — попроси админа подтвердить кнопкой.',
      inputSchema: z.object({ id: z.string().min(1) }),
      execute: async ({ id }) => {
        const p = await getProxyById(id)
        if (!p) return { ok: false, message: 'Прокси не найден' }
        state.pending = {
          kind: 'delete_proxy',
          label: `Удалить прокси ${truncate(p.label ?? p.host, 40)}`,
          detail:
            'Каналы, привязанные к этому прокси, останутся без него и могут потерять соединение.',
          payload: { id },
        }
        return { ok: true, needsConfirmation: true }
      },
    }),
  }
}
