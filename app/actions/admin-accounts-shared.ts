import { getProxyById, proxyTypeInUse } from '@/lib/data'
import type { ChannelStatus, ChannelType, SessionStatus } from '@/lib/types'

/**
 * Shared contract + proxy validation for the admin account actions
 * (admin-accounts-telegram / -bots / -maintenance). NOT a 'use server' file —
 * it exports types and a plain helper, not server actions.
 */

export interface AdminAccountResult {
  ok: boolean
  message: string
  channelId?: string
  sessionStatus?: SessionStatus
}

export interface ChannelStatusSnapshot {
  sessionStatus: SessionStatus
  status: ChannelStatus
  lastError: string | null
  detail: string
  codeDelivery: 'app' | 'sms' | null
}

/**
 * Enforce the proxy allocation rules for a NEW/edited account:
 *  1. A proxy is OPTIONAL — when omitted the account connects directly. This
 *     matters because some proxies can't tunnel Telegram MTProto/WebSocket, so
 *     a direct connection must always be possible as a fallback.
 *  2. When a proxy IS chosen it serves at most ONE account per type (different
 *     types may share).
 *  3. MTProto proxies are Telegram-only (they can't tunnel VK/MAX/WhatsApp HTTP).
 * Returns an error string, or null when the selection is valid to use.
 */
export async function validateProxyForType(
  proxyId: string | null,
  type: ChannelType,
  excludeChannelId?: string,
): Promise<string | null> {
  // No proxy → direct connection. Always allowed.
  if (!proxyId) return null
  const proxy = await getProxyById(proxyId)
  if (!proxy) return 'Указанный прокси не найден.'
  if (proxy.kind === 'mtproto' && type !== 'telegram') {
    return 'MTProto-прокси подходит только для Telegram. Для VK/MAX/WhatsApp выберите socks5 или http прокси.'
  }
  // GramJS has no HTTP-CONNECT transport: an HTTP proxy passed to a Telegram
  // session used to be silently treated as SOCKS5 and hang the connection.
  if (proxy.kind === 'http' && type === 'telegram') {
    return 'HTTP-прокси не поддерживается Telegram (MTProto). Выберите SOCKS5 или MTProto-прокси.'
  }
  if (await proxyTypeInUse(proxyId, type, excludeChannelId)) {
    return `Этот прокси уже используется другим аккаунтом «${type}». Одно прокси = один аккаунт каждого типа — выберите другой.`
  }
  return null
}
