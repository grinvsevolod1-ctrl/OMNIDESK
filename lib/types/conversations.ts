import type { ChannelType } from './channels'
import type { LeadStatus, NotLiquidReason } from './leads'

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
  /**
   * True when the lead was передан куратору (миграция 151): диалог виден
   * менеджеру только для чтения, а активно ведёт его куратор. ИИ менеджера при
   * этом молчит (гейт curator_id IS NULL).
   */
  transferred?: boolean
  /** Имя куратора, которому передан диалог (для бейджа у менеджера). */
  curatorName?: string
  /** ISO-время передачи диалога куратору. */
  transferredToCuratorAt?: string
  /**
   * Текущий статус лид-карточки у куратора (enum из lib/lead-status.ts, НЕ из
   * conversation-статусов). Заполняется только в списках менеджера, где нужно
   * разделить переданные диалоги на «у куратора в работе» и «Доработки»
   * (куратор поставил Игнор/Отказался/Не связался). undefined — карточки нет
   * или диалог не передан.
   */
  curatorLeadStatus?: string | null
  /** Лид-карточка ушла в архив у куратора (lead_cards.archived_at). */
  curatorArchived?: boolean
  /**
   * Менеджер убрал вернувшийся на дожим лид «в trash» (lead_cards
   * .rework_trashed_at, миграция 155) — карточка исчезает из «Доработок» и
   * больше нигде у менеджера не показывается. Терминальное менеджерское
   * состояние, кураторский статус при этом не трогается.
   */
  curatorReworkTrashed?: boolean
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
