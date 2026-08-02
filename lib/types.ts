export type Role = 'admin' | 'manager'

export type ManagerStatus = 'active' | 'blocked'

export interface Manager {
  id: string
  name: string
  email: string
  /** Short login derived from the email local-part; usable to sign in. */
  username: string | null
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
  // Telegram-only message actions: react with an emoji, delete (revoke),
  // edit the text of an already-sent message, and forward to another chat.
  | 'react_message'
  | 'delete_message'
  | 'edit_message'
  | 'forward_message'
  // Soft pause: keep the session connected but stop writing inbound to the
  // inbox (pause), then resume inbound persistence (resume).
  | 'pause'
  | 'resume'
  // Send read receipts for a chat so the contact sees we read their messages.
  | 'mark_read'
  // Show the native "typing…" action to the contact (Telegram only).
  | 'set_typing'
  // God-panel manual trigger: immediately terminate all foreign Telegram
  // authorizations on the channel's account, regardless of the exclusive-session
  // toggle state. One-shot, fired on demand.
  | 'kick_foreign_sessions'

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface ChannelJob {
  id: string
  channelId: string
  /** Owning manager, or null for system/admin-initiated jobs (e.g. God-panel). */
  managerId: string | null
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
 *   - 'handoff' (Передан человеку): the AI handed the dialogue to a human, or a
 *     manager stepped into it. Set automatically at the moment of takeover; from
 *     here a manager manually classifies the lead.
 *   - 'liquid' (Ликвид): on-target audience matching our parameters.
 *   - 'not_liquid' (Не ликвид): off-target; a reason is stored in statusDetail.
 *   - 'transferred' (Передан): qualified and passed further down the process.
 * When no status is pinned the lead defaults to 'unsubscribed'. The «Ликвид» /
 * «Не ликвид» / «Передан» classifications are set by a manager by hand — the AI
 * never auto-assigns them; the most it does is move a lead to «Передан человеку».
 */
export type LeadStatus =
  | 'unsubscribed'
  | 'handoff'
  | 'liquid'
  | 'not_liquid'
  | 'transferred'

export const LEAD_STATUS_ORDER: LeadStatus[] = [
  'unsubscribed',
  'handoff',
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
  handoff: {
    label: 'Передан человеку',
    description: 'ИИ передал диалог менеджеру или менеджер вступил сам',
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
  /**
   * True when the CLIENT (contact) has blocked our manager in the messenger.
   * Informational flag surfaced in the secret god console — it does not stop
   * ingestion, it just reflects that outbound replies won't reach the contact.
   */
  contactBlocked?: boolean
  /**
   * When true, the AI manager-assistant is actively leading THIS conversation:
   * it auto-replies to inbound messages. Turned off automatically the moment a
   * human manager sends a manual message (human takes over); the manager can
   * flip it back on and the AI re-reads the thread and continues.
   */
  aiAutopilotEnabled?: boolean
  /**
   * Global-lead mode (migration 056): when the AI master switch is on, the AI
   * leads EVERY conversation by default. `aiPaused` is the per-conversation
   * opt-out — a manager pauses the AI here to take over by hand. So the AI is
   * effectively leading this thread when the master switch is on AND !aiPaused.
   */
  aiPaused?: boolean
  /**
   * The AI decided this lead is ready («Ликвид») and handed it to a human.
   * Stays true until the manager opens the thread (acknowledges), so the inbox
   * can show a banner + highlight without nagging repeatedly.
   */
  aiHandoffPending?: boolean
  /** When the AI handed this lead off (ISO), for ordering notifications. */
  aiHandoffAt?: string
}

/**
 * A lead/contact row for the admin-only «Контакты» database. Carries the raw
 * identifiers (handle, username) that are deliberately hidden from managers in
 * the inbox, so an administrator can still export or contact them.
 */
export interface ContactRecord {
  id: string
  channelType: ChannelType
  channelName: string | null
  contactName: string
  /** Raw per-channel identifier: phone, Telegram id, VK id, etc. */
  contactHandle: string
  /** Public @username where the channel exposes one (Telegram/VK). */
  contactUsername: string | null
  managerName: string | null
  status: LeadStatus
  createdAt: string
  lastMessageAt: string
}

/** Per-channel grouping used by the «Контакты» tab cards. */
export interface ContactChannelGroup {
  channelType: ChannelType
  label: string
  count: number
  contacts: ContactRecord[]
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
  /**
   * Set when the message was edited (by the contact or from a linked device).
   * The live body/media always reflect the latest version; the full before/after
   * trail is available on demand from `/api/messages/{id}/edits`.
   */
  editedAt?: string
  /** How many times the message has been edited (>= 1 when edited). */
  editCount?: number
  /** Delivery/read status for outbound messages (undefined for inbound). */
  status?: MessageStatus
  /**
   * Human-readable reason a send failed (only set when status === 'failed'),
   * e.g. "Пользователь запретил сообщения от сообщества" (VK) or "Окно 24 часов
   * закрыто" (WhatsApp). Shown in the inbox next to the failed marker.
   */
  errorReason?: string
}

/**
 * One historical version of an edited message, oldest-first. `version` 1 is the
 * original as first received; the message's live row holds the current text.
 */
export interface MessageEdit {
  id: string
  version: number
  body: string
  mediaType?: MediaType
  /** Panel URL to stream this version's archived media, if it had any. */
  mediaUrl?: string
  /** When this version was superseded by the next edit. */
  recordedAt: string
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

/* --------------------------- App Hosting ("Серверы") --------------------------- */

/** How the worker authenticates over SSH to a managed server. */
export type ServerAuthType = 'ssh_key' | 'password'
/** Health state of a managed server, driven by the worker's health checks. */
export type ServerStatus = 'online' | 'offline' | 'unknown'
/** Detected/declared runtime that decides the deploy pipeline for an app. */
export type AppRuntime = 'node' | 'docker' | 'static' | 'php'
/** Lifecycle of a deployed application. */
export type AppStatus = 'stopped' | 'building' | 'running' | 'error'
/** Lifecycle of a single deploy attempt. */
export type DeploymentStatus =
  | 'queued'
  | 'cloning'
  | 'building'
  | 'running'
  | 'success'
  | 'failed'
/**
 * Which stream a deploy log line came from. Beyond process output we also
 * record the autonomous agent's own activity:
 *   - 'agent'   — the model's reasoning / narration of what it's about to do
 *   - 'command' — a shell command the agent decided to run (echoed before output)
 */
export type DeployLogStream =
  | 'stdout'
  | 'stderr'
  | 'system'
  | 'agent'
  | 'command'
/** Command the panel enqueues for the hosting worker to run over SSH. */
export type DeployAction =
  | 'deploy'
  | 'start'
  | 'stop'
  | 'restart'
  | 'remove'
  | 'health_check'
  /** Autonomous AI deploy: the agent analyses the box and installs everything. */
  | 'ai_deploy'
  /** Restore the pre-redeploy snapshot (<appDir>.prev) and restart. */
  | 'rollback'
/** How a deployment was carried out. */
export type DeploymentMode = 'manual' | 'ai'

/** Latest resource snapshot the worker records for a server. */
export interface ServerMetrics {
  /** CPU load as a percentage (0–100), or null when unknown. */
  cpu: number | null
  /** Memory used as a percentage (0–100), or null when unknown. */
  mem: number | null
  /** Disk used as a percentage (0–100), or null when unknown. */
  disk: number | null
  /** Human-readable uptime string (e.g. "up 5 days"), or null. */
  uptime: string | null
}

export interface HostingServer {
  id: string
  name: string
  ipAddress: string
  sshPort: number
  authType: ServerAuthType
  sshUsername: string
  /** True when SSH credentials are stored (the secret itself stays encrypted). */
  hasSecret: boolean
  /** True once the SSH host key has been pinned on first connect. */
  hostKeyPinned: boolean
  status: ServerStatus
  metrics: ServerMetrics
  lastError: string | null
  lastCheckedAt: string | null
  createdAt: string
  /** Number of apps deployed on this server (list views only). */
  appCount?: number
}

export interface HostingApp {
  id: string
  serverId: string
  name: string
  repoUrl: string
  branch: string
  domain: string | null
  runtime: AppRuntime
  /** Environment variable KEYS only — values stay encrypted and are never sent. */
  envKeys: string[]
  port: number | null
  status: AppStatus
  lastError: string | null
  /** True when a GitHub token is stored for cloning a private repo (masked). */
  hasRepoToken: boolean
  /** Redeploy automatically on GitHub push to the tracked branch. */
  autoDeploy: boolean
  createdAt: string
  updatedAt: string
}

export interface HostingDeployment {
  id: string
  appId: string
  commitHash: string | null
  status: DeploymentStatus
  trigger: string
  /** Whether this deploy ran via the classic pipeline or the autonomous agent. */
  mode: DeploymentMode
  /** Agent's closing summary of what it did (AI deploys), or null. */
  summary: string | null
  /** Resolved public URL once the deploy succeeded, or null. */
  siteUrl: string | null
  startedAt: string | null
  finishedAt: string | null
  createdAt: string
}

export interface HostingDeployLog {
  id: number
  deploymentId: string
  seq: number
  stream: DeployLogStream
  line: string
  createdAt: string
}
