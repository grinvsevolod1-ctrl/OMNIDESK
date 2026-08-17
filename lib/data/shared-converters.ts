/**
 * Row → domain converters for the core entities (Manager, Channel,
 * Conversation, Message). Split out of shared.ts, which re-exports this module
 * so every existing `./shared` import keeps working. Same layering rule
 * applies: domain modules import FROM here, this module imports nothing from
 * `lib/data`.
 */
import type {
  AccountRole,
  Channel,
  Conversation,
  ConversationMeta,
  LeadStatus,
  Manager,
  MediaType,
  Message,
  MessageReaction,
  MessageStatus,
  NotLiquidReason,
} from '../types'
import {
  DEFAULT_LEAD_STATUS,
  SECRET_CONFIG_KEYS,
  type ChannelRow,
  type ConversationRow,
  type ManagerRow,
} from './shared'

export function toManager(r: ManagerRow): Manager {
  const role: AccountRole =
    r.role === 'curator' ? 'curator' : r.role === 'head' ? 'head' : 'manager'
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    username: r.username ?? null,
    status: r.status,
    onLunch: r.on_lunch ?? false,
    role,
    city: role === 'curator' ? (r.city ?? null) : null,
    headCanEdit: role === 'head' ? Boolean(r.head_can_edit) : false,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

export function sanitizeChannelConfig(
  config: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!config) return {}
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(config)) {
    if (!SECRET_CONFIG_KEYS.has(k)) out[k] = v
  }
  return out
}

export function toChannel(r: ChannelRow): Channel {
  return {
    id: r.id,
    managerId: r.manager_id,
    type: r.type,
    name: r.name,
    detail: r.detail,
    status: r.status,
    sessionStatus: r.session_status ?? 'idle',
    ingestPaused: r.ingest_paused ?? false,
    phone: r.phone ?? null,
    proxyId: r.proxy_id ?? null,
    lastError: r.last_error ?? null,
    config: sanitizeChannelConfig(r.config),
    createdAt: new Date(r.created_at).toISOString(),
    connectedAt: r.connected_at
      ? new Date(r.connected_at).toISOString()
      : null,
    lastCheckedAt: r.last_checked_at
      ? new Date(r.last_checked_at).toISOString()
      : null,
    sessionStatusChangedAt: r.session_status_changed_at
      ? new Date(r.session_status_changed_at).toISOString()
      : null,
  }
}

export function toConversation(r: ConversationRow): Conversation {
  const manual = (r.status ?? null) as LeadStatus | null
  const detail = (r.status_detail ?? null) as NotLiquidReason | null
  return {
    id: r.id,
    channelId: r.channel_id,
    managerId: r.manager_id,
    channelType: r.channel_type,
    // Reversible "names glitch": show "NULL" while hidden, real name is intact in DB.
    contactName: r.contact_name_hidden ? 'NULL' : r.contact_name,
    contactHandle: r.contact_handle,
    contactUsername: r.contact_username ?? undefined,
    lastMessage: r.last_message,
    lastMessageAt: new Date(r.last_message_at).toISOString(),
    unread: Number(r.unread),
    status: manual ?? DEFAULT_LEAD_STATUS,
    statusDetail:
      manual === 'not_liquid' && detail ? detail : undefined,
    statusManual: manual !== null,
    statusUpdatedAt: r.status_updated_at
      ? new Date(r.status_updated_at).toISOString()
      : undefined,
    replyDismissedAt: r.reply_dismissed_at
      ? new Date(r.reply_dismissed_at).toISOString()
      : undefined,
    muted: Boolean(r.muted),
    contactBlocked: Boolean(r.contact_blocked),
    visitorNo:
      r.visitor_no === null || r.visitor_no === undefined
        ? undefined
        : Number(r.visitor_no),
    meta:
      r.meta && Object.keys(r.meta).length > 0
        ? (r.meta as ConversationMeta)
        : undefined,
    aiAutopilotEnabled: Boolean(r.ai_autopilot_enabled),
    aiPaused: Boolean(r.ai_paused),
    aiHandoffPending: Boolean(r.ai_handoff_pending),
    aiHandoffAt: r.ai_handoff_at
      ? new Date(r.ai_handoff_at).toISOString()
      : undefined,
  }
}

/**
 * Map a raw `messages` row (with optional media columns) to a `Message`.
 * `mediaUrl` points at the panel proxy that streams the bytes on demand.
 */
export function toMessage(r: {
  id: string
  conversation_id: string
  direction: 'in' | 'out'
  body: string
  author: string
  created_at: string | Date
  media_type?: MediaType | null
  media_mime?: string | null
  media_name?: string | null
  reactions?: unknown
  deleted_at?: string | Date | null
  deleted_origin?: 'self' | 'remote' | null
  edited_at?: string | Date | null
  edit_count?: number | null
  status?: MessageStatus | null
  error_reason?: string | null
  reply_to_id?: string | null
  reply_to_author?: string | null
  reply_to_body?: string | null
  reply_to_media_type?: MediaType | null
}): Message {
  const reactions = Array.isArray(r.reactions)
    ? (r.reactions as MessageReaction[]).filter(
        (x) => x && typeof x.emoji === 'string',
      )
    : []
  return {
    id: r.id,
    conversationId: r.conversation_id,
    direction: r.direction,
    body: r.body,
    author: r.author,
    createdAt: new Date(r.created_at).toISOString(),
    ...(r.media_type
      ? {
          mediaType: r.media_type,
          mediaMime: r.media_mime ?? undefined,
          mediaName: r.media_name ?? undefined,
          mediaUrl: `/api/media/${r.id}`,
        }
      : {}),
    ...(reactions.length ? { reactions } : {}),
    ...(r.deleted_at ? { deletedAt: new Date(r.deleted_at).toISOString() } : {}),
    ...(r.deleted_origin ? { deletedOrigin: r.deleted_origin } : {}),
    ...(r.edited_at
      ? {
          editedAt: new Date(r.edited_at).toISOString(),
          editCount: Number(r.edit_count ?? 0),
        }
      : {}),
    ...(r.status ? { status: r.status } : {}),
    ...(r.error_reason ? { errorReason: r.error_reason } : {}),
    ...(r.reply_to_id
      ? {
          replyTo: {
            id: r.reply_to_id,
            author: r.reply_to_author ?? '',
            body: r.reply_to_body ?? '',
            ...(r.reply_to_media_type
              ? { mediaType: r.reply_to_media_type }
              : {}),
          },
        }
      : {}),
  }
}
