'use client'

/**
 * Shared label/style maps and small helpers for the secret dashboard, extracted
 * from the secret-dashboard monolith so the root component and its per-tab
 * sub-modules (channels, mass-import, …) can share them without duplication.
 */

import { toast } from 'sonner'

export const TYPE_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  vk: 'VK',
  max: 'MAX',
  livechat: 'Онлайн-чат',
}

export const CONV_STATUS_LABEL: Record<string, string> = {
  liquid: 'Ликвид',
  not_liquid: 'Не ликвид',
  unsubscribed: 'Отписка',
  handoff: 'Передан человеку',
  transferred: 'Передан',
}

export const CONV_STATUS_STYLE: Record<string, string> = {
  liquid: 'bg-success/15 text-success',
  not_liquid: 'bg-warning/15 text-warning',
  unsubscribed: 'bg-muted text-muted-foreground',
  handoff: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  transferred: 'bg-chart-2/15 text-foreground',
}

/** Module-level so the React Compiler never treats it as reactive state. */
export function copyText(text: string, label = 'ID') {
  if (typeof navigator === 'undefined' || !navigator.clipboard) {
    toast.error('Буфер обмена недоступен')
    return
  }
  navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`${label} скопирован`))
    .catch(() => toast.error('Не удалось скопировать'))
}

export function convStatusLabel(status: string): string {
  return CONV_STATUS_LABEL[status] ?? status
}
