import { channelIcon } from '@/components/channel-icons'
import type { Proxy } from '@/lib/types'

/** Source types an admin can create accounts for. */
export type CreatableType = 'telegram' | 'vk' | 'max'

export const TYPE_ICON = {
  telegram: channelIcon('telegram'),
  whatsapp: channelIcon('whatsapp'),
  vk: channelIcon('vk'),
  max: channelIcon('max'),
} as const

export const SESSION_LABEL: Record<string, string> = {
  idle: 'Ожидание',
  starting: 'Запуск…',
  qr_pending: 'Ждёт QR',
  code_pending: 'Ждёт код',
  password_pending: 'Ждёт пароль',
  online: 'В сети',
  offline: 'Не в сети',
  error: 'Ошибка',
  logged_out: 'Вышел из аккаунта',
  rate_limited: 'Ограничен',
}

export function proxyLabelText(p: Proxy): string {
  return `${p.label} · ${p.kind} · ${p.host}:${p.port}`
}

/**
 * Whether a proxy can serve an account of `type`:
 *  - MTProto proxies are Telegram-only (they can't tunnel VK/MAX/WhatsApp HTTP).
 *  - The proxy must not already be bound to another account of the same type.
 */
export function proxyEligible(
  p: Proxy,
  type: CreatableType,
  usage: Record<string, string[]>,
): boolean {
  if (p.kind === 'mtproto' && type !== 'telegram') return false
  const used = usage[p.id] ?? []
  return !used.includes(type)
}
