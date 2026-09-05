/**
 * Managed dictionaries — the single source for every human-readable label that
 * used to be hardcoded across the admin/manager UI: lead status names, channel
 * type labels, proxy/hosting status captions, the OS-shell quick commands, etc.
 *
 * Design:
 *   - Stable KEYS (`liquid`, `telegram`, ...) never change — they live in the
 *     DB and in TypeScript unions. Only the PRESENTATION (label, description,
 *     order) is editable.
 *   - DEFAULTS below mirror the historical hardcoded values byte-for-byte, so
 *     an installation without overrides behaves exactly as before.
 *   - Overrides live in the `app_settings` table under the `dictionaries` key
 *     (see lib/data/dictionaries.ts) and are deep-merged over the defaults.
 *   - This module is CLIENT-SAFE: no DB imports. The server data layer and the
 *     React context provider both consume it.
 */
import {
  LEAD_STATUS_META,
  MANUAL_LEAD_STATUS_ORDER,
  NOT_LIQUID_REASON_META,
  NOT_LIQUID_REASON_ORDER,
  type LeadStatus,
  type LeadStatusOption,
  type NotLiquidReason,
} from './types'

/* ------------------------------ shapes ------------------------------ */

export interface StatusMeta {
  label: string
  description: string
}

export interface Dictionaries {
  /** Lead lifecycle statuses (keys are stable enum values). */
  leadStatuses: Record<LeadStatus, StatusMeta>
  /** «Не ликвид» reason sub-statuses. */
  notLiquidReasons: Record<NotLiquidReason, StatusMeta>
  /** Channel/messenger type captions (telegram, whatsapp, vk, max, ...). */
  channelTypes: Record<string, string>
  /** Personal-account status captions (active, cooldown, banned, ...). */
  accountStatuses: Record<string, string>
  /** Proxy status captions. */
  proxyStatuses: Record<string, string>
  /** Hosting: server status captions. */
  serverStatuses: Record<string, string>
  /** Hosting: app status captions. */
  appStatuses: Record<string, string>
  /** Hosting: deployment status captions. */
  deploymentStatuses: Record<string, string>
  /** OS-shell quick command chips (label + the prompt it sends). */
  shellQuickCommands: { label: string; prompt: string }[]
  /** OS-shell copilot greeting shown before the first exchange. */
  shellGreeting: string
}

/* ----------------------------- defaults ----------------------------- */

export const DEFAULT_DICTIONARIES: Dictionaries = {
  // The lead-status / reason defaults are the canonical constants from
  // lib/types.ts — a single source, no drift.
  leadStatuses: LEAD_STATUS_META,
  notLiquidReasons: NOT_LIQUID_REASON_META,
  channelTypes: {
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    vk: 'VK',
    max: 'MAX',
    livechat: 'Онлайн-чат',
  },
  accountStatuses: {
    connected: 'Подключён',
    pending: 'Подключается',
    error: 'Ошибка',
    disconnected: 'Отключён',
  },
  proxyStatuses: {
    ok: 'Работает',
    error: 'Не работает',
    unknown: 'Не проверен',
  },
  serverStatuses: {
    online: 'В сети',
    offline: 'Не в сети',
    unknown: 'Не проверен',
  },
  appStatuses: {
    stopped: 'Остановлено',
    building: 'Сборка',
    running: 'Работает',
    error: 'Ошибка',
  },
  deploymentStatuses: {
    queued: 'В очереди',
    cloning: 'Клонирование',
    building: 'Сборка',
    running: 'Запуск',
    success: 'Успешно',
    failed: 'Ошибка',
  },
  shellQuickCommands: [
    { label: 'Сводка за сегодня', prompt: 'Покажи сводку за сегодня' },
    { label: 'Статусы аккаунтов', prompt: 'Покажи статусы всех аккаунтов' },
    { label: 'Менеджеры', prompt: 'Покажи список менеджеров' },
    { label: 'Финансы за месяц', prompt: 'Покажи финансовую сводку за месяц' },
    { label: 'Каналы и прокси', prompt: 'Покажи каналы и прокси' },
    { label: 'Контакты', prompt: 'Покажи последние контакты' },
  ],
  shellGreeting:
    'Я управляю всей админкой: метрики, менеджеры, аккаунты, финансы, каналы, прокси, контакты и справочники. Спросите или скомандуйте — опасные действия выполню только после вашего подтверждения.',
}

/* ------------------------------ helpers ----------------------------- */

/** Deep-merge a stored (partial, possibly stale) override onto the defaults. */
export function resolveDictionaries(raw: unknown): Dictionaries {
  const src = (raw ?? {}) as Partial<Record<keyof Dictionaries, unknown>>
  const d = DEFAULT_DICTIONARIES

  const mergeMeta = <K extends string>(
    defaults: Record<K, StatusMeta>,
    over: unknown,
  ): Record<K, StatusMeta> => {
    // Deep-copy every entry: defaults may BE the shared module constants
    // (LEAD_STATUS_META), and updateDictionaryEntry mutates entries in place —
    // a shallow copy would corrupt the canonical defaults for the process.
    const out = Object.fromEntries(
      (Object.keys(defaults) as K[]).map((k) => [k, { ...defaults[k] }]),
    ) as Record<K, StatusMeta>
    if (over && typeof over === 'object') {
      for (const k of Object.keys(defaults) as K[]) {
        const v = (over as Record<string, unknown>)[k]
        if (v && typeof v === 'object') {
          const m = v as Partial<StatusMeta>
          out[k] = {
            label:
              typeof m.label === 'string' && m.label.trim()
                ? m.label.trim()
                : defaults[k].label,
            description:
              typeof m.description === 'string'
                ? m.description
                : defaults[k].description,
          }
        }
      }
    }
    return out
  }

  const mergeLabels = (
    defaults: Record<string, string>,
    over: unknown,
  ): Record<string, string> => {
    const out = { ...defaults }
    if (over && typeof over === 'object') {
      for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim()) out[k] = v.trim()
      }
    }
    return out
  }

  const quick = Array.isArray(src.shellQuickCommands)
    ? (src.shellQuickCommands as unknown[])
        .map((c) => {
          const o = c as { label?: unknown; prompt?: unknown }
          return typeof o?.label === 'string' &&
            o.label.trim() &&
            typeof o?.prompt === 'string' &&
            o.prompt.trim()
            ? { label: o.label.trim(), prompt: o.prompt.trim() }
            : null
        })
        .filter((c): c is { label: string; prompt: string } => c !== null)
    : []

  return {
    leadStatuses: mergeMeta(d.leadStatuses, src.leadStatuses),
    notLiquidReasons: mergeMeta(d.notLiquidReasons, src.notLiquidReasons),
    channelTypes: mergeLabels(d.channelTypes, src.channelTypes),
    accountStatuses: mergeLabels(d.accountStatuses, src.accountStatuses),
    proxyStatuses: mergeLabels(d.proxyStatuses, src.proxyStatuses),
    serverStatuses: mergeLabels(d.serverStatuses, src.serverStatuses),
    appStatuses: mergeLabels(d.appStatuses, src.appStatuses),
    deploymentStatuses: mergeLabels(d.deploymentStatuses, src.deploymentStatuses),
    shellQuickCommands: quick.length > 0 ? quick : d.shellQuickCommands,
    shellGreeting:
      typeof src.shellGreeting === 'string' && src.shellGreeting.trim()
        ? src.shellGreeting.trim()
        : d.shellGreeting,
  }
}

/**
 * Build the selectable lead-status options («Не ликвид» expands into its four
 * reason sub-statuses) from RESOLVED dictionaries. Mirrors the historical
 * LEAD_STATUS_OPTIONS constant but with editable labels.
 */
export function buildLeadStatusOptions(dict: Dictionaries): LeadStatusOption[] {
  // MANUAL_LEAD_STATUS_ORDER, не LEAD_STATUS_ORDER: «Передан» — системный статус,
  // выставляется автоматически при передаче лида, вручную не выбирается.
  return MANUAL_LEAD_STATUS_ORDER.flatMap<LeadStatusOption>((s) =>
    s === 'not_liquid'
      ? NOT_LIQUID_REASON_ORDER.map((r) => ({
          value: `not_liquid:${r}`,
          status: 'not_liquid' as LeadStatus,
          reason: r,
          label: `${dict.leadStatuses.not_liquid.label} · ${dict.notLiquidReasons[r].label}`,
        }))
      : [{ value: s, status: s, label: dict.leadStatuses[s].label }],
  )
}
