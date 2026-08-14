/**
 * 'telegram_personal' — личный Telegram-аккаунт владельца (god-панель):
 * изолированная структура, невидимая для обычной админки/менеджеров/мозга.
 * Все выборки панели фильтруют по конкретным типам, поэтому personal-каналы
 * в обычные интерфейсы не попадают (см. AGENTS.md, раздел про god-панель).
 */
export type ChannelType =
  | 'telegram'
  | 'telegram_personal'
  | 'whatsapp'
  | 'livechat'
  | 'max'
  | 'vk'

export type ChannelStatus = 'connected' | 'pending' | 'error' | 'disconnected'

/**
 * Live session lifecycle reported by the worker. Drives the connect wizard and
 * the channel status badges.
 */
export type SessionStatus =
  | 'idle'
  | 'starting'
  | 'qr_pending'
  | 'code_pending'
  | 'password_pending'
  | 'online'
  | 'offline'
  | 'error'
  | 'logged_out'
  // Provider is throttling/restricting the account, or the worker backed off
  // after repeated reconnect failures to avoid a ban. Auto-reconnect is paused.
  | 'rate_limited'

export interface Channel {
  id: string
  /**
   * Owning manager. NULL when the manager was deleted — the channel (notably a
   * live-chat resource) outlives its owner instead of being cascade-deleted.
   */
  managerId: string | null
  type: ChannelType
  name: string
  /** Non-secret display detail, e.g. @handle, phone number, site domain */
  detail: string
  status: ChannelStatus
  /** Live worker session status (telegram/whatsapp). */
  sessionStatus: SessionStatus
  /**
   * Soft pause: account stays connected/alive but inbound messages are not
   * written to the inbox. Independent of sessionStatus.
   */
  ingestPaused: boolean
  /** Phone number for telegram/whatsapp personal accounts. */
  phone: string | null
  /** Optional proxy assigned to this channel. */
  proxyId: string | null
  /** Last session error surfaced by the worker, if any. */
  lastError: string | null
  config: Record<string, unknown>
  createdAt: string
  connectedAt: string | null
  lastCheckedAt: string | null
  /**
   * When sessionStatus last CHANGED value (maintained by a DB trigger, not by
   * every status re-assert). Lets the UI apply grace periods, e.g. only alert
   * managers about accounts degraded for 5+ minutes.
   */
  sessionStatusChangedAt: string | null
}

export const CHANNEL_META: Record<
  ChannelType,
  { label: string; description: string }
> = {
  telegram: {
    label: 'Telegram',
    description:
      'Connect a personal Telegram account by phone number (MTProto).',
  },
  whatsapp: {
    label: 'WhatsApp',
    description: 'Link a personal WhatsApp account by scanning a QR code.',
  },
  livechat: {
    label: 'Live chat',
    description: 'Embed a live-chat widget on any website via API key.',
  },
  max: {
    label: 'MAX',
    description: 'Connect a MAX bot by its token (Bot API webhook).',
  },
  vk: {
    label: 'VK',
    description:
      'Connect a VK community by its access token (Callback API webhook).',
  },
}

/**
 * Safe accessor for CHANNEL_META. If the DB ever holds a channel with a type
 * outside the known ChannelType union (legacy rows, bad data, a type added in
 * the DB before the enum was updated), a direct `CHANNEL_META[type]` lookup
 * returns undefined and crashes on `.label`. This never throws: it falls back
 * to a readable label derived from the raw type string.
 */
export function getChannelMeta(type: string | null | undefined): {
  label: string
  description: string
} {
  if (type && type in CHANNEL_META) {
    return CHANNEL_META[type as ChannelType]
  }
  const raw = (type ?? '').trim()
  const label = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : 'Канал'
  return { label, description: '' }
}
