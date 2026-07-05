export type Role = 'admin' | 'manager'

export type ManagerStatus = 'active' | 'blocked'

export interface Manager {
  id: string
  name: string
  email: string
  status: ManagerStatus
  /** True while the manager is on lunch — new conversations route elsewhere. */
  onLunch: boolean
  createdAt: string
}

export type ChannelType = 'telegram' | 'whatsapp' | 'livechat' | 'max' | 'vk'

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
}

export type ProxyKind = 'socks5' | 'http' | 'mtproto'
export type ProxyStatus = 'unknown' | 'ok' | 'error'

export interface Proxy {
  id: string
  /**
   * The manager this proxy is ASSIGNED to (the account that routes connections
   * through it), or null when it sits unassigned in the admin pool. Assignment
   * is independent of ownership: an admin can assign a pool proxy to a manager,
   * and a manager-owned proxy is auto-assigned to its creator.
   */
  managerId: string | null
  /** Display name of the assigned manager (admin views only). */
  assignedManagerName?: string | null
  /** Who created/owns the proxy. Admin-owned proxies are read-only for managers. */
  createdByRole: Role
  /** The manager who created it (null for admin-created proxies). */
  createdByManagerId: string | null
  /** Display name of the owner manager, when created by a manager (admin views). */
  ownerManagerName?: string | null
  label: string
  kind: ProxyKind
  host: string
  port: number
  /** True when credentials are stored (values themselves stay encrypted). */
  hasAuth: boolean
  status: ProxyStatus
  lastError: string | null
  createdAt: string
}

export interface ProxyAnalytics {
  total: number
  /** Health rollup across every proxy. */
  ok: number
  error: number
  unknown: number
  /** Assigned to a manager vs. sitting unused in the pool. */
  assigned: number
  unassigned: number
  /** Ownership split. */
  adminOwned: number
  managerOwned: number
  /** Number of channels currently routed through a proxy. */
  channelsRouted: number
}

export interface ManagerProxySummary {
  manager: Manager
  /** Proxies assigned to this manager. */
  total: number
  ok: number
  error: number
  unknown: number
  /** How many of the assigned proxies the manager created themselves. */
  selfOwned: number
  /** How many were handed down by the admin. */
  adminAssigned: number
  /** Channels this manager routes through a proxy. */
  channelsRouted: number
}

export type JobAction =
  | 'start'
  | 'stop'
  | 'restart'
  | 'logout'
  | 'send_code'
  | 'send_password'
  | 'request_qr'
  | 'send_message'
  // Send a sticker (Telegram only) by its document descriptor.
  | 'send_sticker'
  // Telegram-only message actions: react with an emoji, delete (revoke), and
  // forward to another chat.
  | 'react_message'
  | 'delete_message'
  | 'forward_message'
  // Soft pause: keep the session connected but stop writing inbound to the
  // inbox (pause), then resume inbound persistence (resume).
  | 'pause'
  | 'resume'
  // Send read receipts for a chat so the contact sees we read their messages.
  | 'mark_read'

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface ChannelJob {
  id: string
  channelId: string
  managerId: string
  action: JobAction
  payload: Record<string, unknown>
  status: JobStatus
  result: Record<string, unknown> | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

export type MessageDirection = 'in' | 'out'

/**
 * Delivery lifecycle of an OUTBOUND message, mirroring messenger ticks:
 *   sent      -> accepted by the provider          (single ✓)
 *   delivered -> reached the contact's device      (double ✓, grey)
 *   read      -> the contact opened/read it         (double ✓, blue)
 *   failed    -> the provider rejected the send     (! warning)
 * Inbound messages have no status (undefined).
 */
export type MessageStatus = 'sent' | 'delivered' | 'read' | 'failed'

/**
 * Lead lifecycle status. A "lead" is a conversation/contact that wrote in.
 * Business model:
 *   - 'unsubscribed' (Отписок): default — everyone who ever wrote in.
 *   - 'liquid' (Ликвид): on-target audience matching our parameters.
 *   - 'not_liquid' (Не ликвид): off-target; a reason is stored in statusDetail.
 *   - 'transferred' (Передан): qualified and passed further down the process.
 * When no status is pinned the lead defaults to 'unsubscribed'.
 */
export type LeadStatus = 'unsubscribed' | 'liquid' | 'not_liquid' | 'transferred'

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  'unsubscribed',
  'liquid',
  'not_liquid',
  'transferred',
]

export const LEAD_STATUS_META: Record<
  LeadStatus,
  { label: string; description: string }
> = {
  unsubscribed: {
    label: 'Отписок',
    description: 'Всего написавших людей',
  },
  liquid: {
    label: 'Ликвид',
    description: 'Подходящая аудитория по нужным параметрам',
  },
  not_liquid: {
    label: 'Не ликвид',
    description: 'Не подходящая аудитория',
  },
  transferred: {
    label: 'Передан',
    description: 'Подошёл, прошёл и передан дальше',
  },
}

/**
 * Reason sub-status for the «Не ликвид» bucket. Only meaningful when a lead's
 * status is 'not_liquid'.
 */
export type NotLiquidReason = 'geo' | 'under18' | 'na' | 'trash'

export const NOT_LIQUID_REASON_ORDER: NotLiquidReason[] = [
  'geo',
  'under18',
  'na',
  'trash',
]

export const NOT_LIQUID_REASON_META: Record<
  NotLiquidReason,
  { label: string; description: string }
> = {
  geo: { label: 'Гео', description: 'Не наше гео' },
  under18: { label: '-18', description: 'Младше 18 лет' },
  na: { label: 'NA', description: 'Не отвечает / не актуально' },
  trash: { label: 'TRASH', description: 'Мусорный контакт' },
}

/**
 * A single selectable status option. «Не ликвид» is expanded into its four
 * reason sub-statuses (Гео / -18 / NA / TRASH) so they appear as standalone
 * choices in pickers, while the other statuses stay as-is. `value` is a stable
 * string key for radio groups; `status`/`reason` are what to persist.
 */
export interface LeadStatusOption {
  value: string
  status: LeadStatus
  reason?: NotLiquidReason
  label: string
}

export const LEAD_STATUS_OPTIONS: LeadStatusOption[] =
  LEAD_STATUS_ORDER.flatMap<LeadStatusOption>((s) =>
    s === 'not_liquid'
      ? NOT_LIQUID_REASON_ORDER.map((r) => ({
          value: `not_liquid:${r}`,
          status: 'not_liquid' as LeadStatus,
          reason: r,
          label: `${LEAD_STATUS_META.not_liquid.label} · ${NOT_LIQUID_REASON_META[r].label}`,
        }))
      : [{ value: s, status: s, label: LEAD_STATUS_META[s].label }],
  )

/** Build the radio-group value for a conversation's current status + reason. */
export function leadStatusOptionValue(
  status: LeadStatus,
  reason?: NotLiquidReason | null,
): string {
  return status === 'not_liquid' && reason ? `not_liquid:${reason}` : status
}

/**
 * Privacy-scoped context about a website live-chat visitor. Every field is
 * optional — we only ever show what was actually captured, never placeholders.
 */
export interface ConversationMeta {
  /** Visitor IP, captured server-side from request headers. */
  ip?: string
  /** Raw User-Agent string (server header). */
  userAgent?: string
  /** Browser language, e.g. "ru-RU". */
  language?: string
  /** IANA timezone reported by the browser, e.g. "Europe/Moscow". */
  timezone?: string
  /** Screen size string, e.g. "1920×1080". */
  screen?: string
  /** URL of the page the widget was loaded on. */
  page?: string
  /** Document referrer, if any. */
  referrer?: string
  /** Optional subject/topic passed by the host page (e.g. a vacancy/position). */
  subject?: string
  /** ISO timestamp the visitor was first recorded. */
  firstSeen?: string
  /** ISO timestamp of the visitor's most recent message. */
  lastSeen?: string
}

export interface Conversation {
  id: string
  channelId: string
  managerId: string
  channelType: ChannelType
  /** Display name of the source channel/integration (site, account, etc.). */
  channelName?: string
  contactName: string
  contactHandle: string
  /**
   * Public @username of the contact (without the leading '@'), when known.
   * Telegram users may have one; stored separately from the addressing handle
   * so the panel can show it next to the display name.
   */
  contactUsername?: string
  lastMessage: string
  lastMessageAt: string
  unread: number
  /** Effective lead status: manual override if pinned, else default (Отписок). */
  status: LeadStatus
  /** Reason sub-status, set only when status is 'not_liquid'. */
  statusDetail?: NotLiquidReason
  /** True when a manager pinned the status manually (vs. the default). */
  statusManual: boolean
  /** ISO timestamp of the last manual status change, if any. */
  statusUpdatedAt?: string
  /**
   * ISO timestamp at which the manager marked this thread as "no reply needed".
   * The thread is considered awaiting a reply only when its last inbound message
   * is newer than this, so a fresh inbound message reactivates it automatically.
   */
  replyDismissedAt?: string
  /**
   * When true the conversation is silenced: no push notifications, hidden from
   * the default inbox list, and excluded from "awaiting reply" sorting/reminders.
   */
  muted?: boolean
  /**
   * Small human-readable per-channel ordinal assigned to a live-chat visitor at
   * creation time (#1, #2, …). Lets managers tell anonymous website visitors
   * apart. Undefined for messenger contacts and pre-migration rows.
   */
  visitorNo?: number
  /** Visitor context (live-chat only). */
  meta?: ConversationMeta
}

/** Kinds of media a message can carry (mirrors the DB check constraint). */
export type MediaType =
  | 'image'
  | 'video'
  | 'video_note'
  | 'audio'
  | 'voice'
  | 'sticker'
  | 'document'

export interface Message {
  id: string
  conversationId: string
  direction: MessageDirection
  body: string
  author: string
  createdAt: string
  /** Present when the message carries media (incoming or outgoing sticker). */
  mediaType?: MediaType
  /** MIME type of the media, when known. */
  mediaMime?: string
  /** Original file name, for documents. */
  mediaName?: string
  /**
   * Panel URL to stream the media bytes (`/api/media/{id}`). The worker
   * re-downloads from the provider on demand; nothing binary is stored in the
   * database.
   */
  mediaUrl?: string
  /** Quoted reply preview, when this message replies to another. */
  replyTo?: MessageReplyPreview
  /** Emoji reactions on this message. */
  reactions?: MessageReaction[]
  /**
   * Set when the message was deleted (soft-delete). The original content is
   * preserved; the UI renders it with a "deleted" marker rather than dropping
   * the row.
   */
  deletedAt?: string
  /** Who deleted the message: 'self' = operator, 'remote' = the contact. */
  deletedOrigin?: 'self' | 'remote'
  /** Delivery/read status for outbound messages (undefined for inbound). */
  status?: MessageStatus
}

/** Compact preview of a quoted (replied-to) message. */
export interface MessageReplyPreview {
  id: string
  author: string
  /** Short text/snippet of the quoted message. */
  body: string
  /** Media kind of the quoted message, if it was media. */
  mediaType?: MediaType
}

/** A single emoji reaction on a message. */
export interface MessageReaction {
  emoji: string
  /** True when the reaction was added by the operator (this account). */
  fromMe: boolean
}

/** A sticker offered to the composer, fetched live from the worker. */
export interface StickerItem {
  /** Telegram document id (string to survive JSON / bigint). */
  id: string
  /** Document access hash (string form). */
  accessHash: string
  /** File reference bytes, base64-encoded. */
  fileReference: string
  /** Associated emoji, if any. */
  emoji: string
  /** MIME type of the sticker file (image/webp, video/webm, …). */
  mime: string
}

export interface SessionUser {
  sub: string
  role: Role
  email: string
  name: string
  /**
   * Session version stamped into the JWT at login. Re-checked against the
   * manager's current `session_version` on every request so password changes
   * or blocks revoke outstanding sessions immediately. Admin sessions are 0.
   */
  sv?: number
}

/**
 * A manager's personal canned response. Shown as one-tap chips above the inbox
 * composer so prepared answers can be inserted into the draft instantly.
 */
export interface QuickReply {
  id: string
  title: string
  body: string
  sortOrder: number
  createdAt: string
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
