import 'server-only'
import { query } from '../db'

/**
 * Follow-up autopilot data layer: the chat-configured settings singleton, the
 * silent-client finder, and the per-touch dedup ledger. It treats every
 * AI-enrolled conversation the same way — dialogs are just dialogs.
 */

/** Chat-configured follow-up settings (singleton row). */
export interface FollowupSettings {
  enabled: boolean
  delayHours: number
  maxTouches: number
  quietStart: number
  quietEnd: number
  quietTz: string
  channels: string[]
  updatedAt: string
}

const SUPPORTED_CHANNELS = [
  'livechat',
  'whatsapp',
  'vk',
  'max',
  'telegram',
] as const

interface FollowupRow {
  enabled: boolean
  delay_hours: number | string
  max_touches: number | string
  quiet_start: number | string
  quiet_end: number | string
  quiet_tz: string
  channels: unknown
  updated_at: string | Date
}

function mapSettings(r: FollowupRow): FollowupSettings {
  const channels = Array.isArray(r.channels)
    ? (r.channels as unknown[])
        .map((c) => String(c))
        .filter((c) => (SUPPORTED_CHANNELS as readonly string[]).includes(c))
    : [...SUPPORTED_CHANNELS]
  return {
    enabled: Boolean(r.enabled),
    delayHours: Number(r.delay_hours),
    maxTouches: Number(r.max_touches),
    quietStart: Number(r.quiet_start),
    quietEnd: Number(r.quiet_end),
    quietTz: r.quiet_tz || 'Europe/Moscow',
    channels,
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/** Read the singleton follow-up settings, creating the row lazily if missing. */
export async function getFollowupSettings(): Promise<FollowupSettings> {
  const rows = await query<FollowupRow>(
    `INSERT INTO ai_followup_settings (id) VALUES (true)
       ON CONFLICT (id) DO UPDATE SET id = true
     RETURNING enabled, delay_hours, max_touches, quiet_start, quiet_end,
               quiet_tz, channels, updated_at`,
  )
  return mapSettings(rows[0])
}

/** Patch the follow-up settings; only provided fields change. */
export async function updateFollowupSettings(patch: {
  enabled?: boolean
  delayHours?: number
  maxTouches?: number
  quietStart?: number
  quietEnd?: number
  quietTz?: string
  channels?: string[]
}): Promise<FollowupSettings> {
  const clampHour = (n: number) => Math.max(0, Math.min(23, Math.round(n)))
  const channels =
    patch.channels === undefined
      ? null
      : JSON.stringify(
          patch.channels.filter((c) =>
            (SUPPORTED_CHANNELS as readonly string[]).includes(c),
          ),
        )
  const rows = await query<FollowupRow>(
    `UPDATE ai_followup_settings SET
        enabled     = COALESCE($1, enabled),
        delay_hours = COALESCE($2, delay_hours),
        max_touches = COALESCE($3, max_touches),
        quiet_start = COALESCE($4, quiet_start),
        quiet_end   = COALESCE($5, quiet_end),
        quiet_tz    = COALESCE($6, quiet_tz),
        channels    = COALESCE($7::jsonb, channels),
        updated_at  = now()
      WHERE id = true
      RETURNING enabled, delay_hours, max_touches, quiet_start, quiet_end,
                quiet_tz, channels, updated_at`,
    [
      patch.enabled ?? null,
      patch.delayHours == null
        ? null
        : Math.max(1, Math.min(720, Math.round(patch.delayHours))),
      patch.maxTouches == null
        ? null
        : Math.max(1, Math.min(5, Math.round(patch.maxTouches))),
      patch.quietStart == null ? null : clampHour(patch.quietStart),
      patch.quietEnd == null ? null : clampHour(patch.quietEnd),
      patch.quietTz ?? null,
      channels,
    ],
  )
  if (rows.length === 0) {
    await getFollowupSettings()
    return updateFollowupSettings(patch)
  }
  return mapSettings(rows[0])
}

/** A silent real dialog eligible for a follow-up nudge. */
export interface FollowupCandidate {
  conversationId: string
  managerId: string
  channelId: string
  channelType: string
  contactHandle: string
  /** Nudges already sent in the current silence streak. */
  touchesInStreak: number
  /** ISO time of the last real message in the thread. */
  lastMessageAt: string
}

/**
 * Find AI-led dialogs where the client went silent and a nudge is due:
 *
 *  - AI-enrolled, not on manual pause,
 *  - the last message in the thread was OURS (direction 'out') — i.e. we're
 *    waiting on the client — and it's older than `delayHours`,
 *  - the dialog isn't handed to a human / transferred, nor a lead a manager
 *    explicitly disqualified ('not_liquid'),
 *  - on an allowed channel,
 *  - fewer than `maxTouches` nudges have been sent SINCE the last client
 *    message (so a new client reply resets the streak, and we never exceed the
 *    per-streak cap or double-send for the same silence).
 *
 * Ordered oldest-silence first, capped.
 */
export async function findFollowupCandidates(opts: {
  delayHours: number
  maxTouches: number
  channels: string[]
  limit?: number
}): Promise<FollowupCandidate[]> {
  const channels = opts.channels.filter((c) =>
    (SUPPORTED_CHANNELS as readonly string[]).includes(c),
  )
  if (channels.length === 0) return []
  const cap = Math.max(1, Math.min(200, Math.round(opts.limit ?? 50)))

  const rows = await query<{
    id: string
    manager_id: string
    channel_id: string
    channel_type: string
    contact_handle: string
    last_message_at: string | Date
    touches_in_streak: string | number
  }>(
    `WITH last_inbound AS (
        SELECT conversation_id, MAX(created_at) AS at
          FROM messages
         WHERE direction = 'in' AND deleted_at IS NULL
         GROUP BY conversation_id
     ),
     last_msg AS (
        SELECT DISTINCT ON (conversation_id)
               conversation_id, direction, created_at
          FROM messages
         WHERE deleted_at IS NULL AND body <> ''
         ORDER BY conversation_id, created_at DESC
     )
     SELECT c.id,
            c.manager_id,
            c.channel_id,
            c.channel_type,
            c.contact_handle,
            lm.created_at AS last_message_at,
            COALESCE((
              SELECT COUNT(*) FROM ai_followup_touches t
               WHERE t.conversation_id = c.id
                 AND t.sent_at > COALESCE(li.at, '-infinity'::timestamptz)
            ), 0) AS touches_in_streak
       FROM conversations c
       JOIN ai_assist_settings s ON s.id = true
       JOIN last_msg lm ON lm.conversation_id = c.id
       LEFT JOIN last_inbound li ON li.conversation_id = c.id
      WHERE c.ai_enrolled = true
        AND c.ai_paused = false
        AND s.enabled = true
        AND c.channel_type = ANY($1::text[])
        -- Never auto-nudge dialogs a human owns ('handoff'/'transferred') or a
        -- lead a manager explicitly disqualified ('not_liquid'). The default
        -- 'unsubscribed' here is the neutral "wrote in, not yet pinned" state
        -- (see DEFAULT_LEAD_STATUS), NOT an opt-out, so it stays eligible.
        AND COALESCE(c.status, 'unsubscribed')
            NOT IN ('handoff', 'transferred', 'not_liquid')
        AND li.at IS NOT NULL
        AND lm.direction = 'out'
        AND lm.created_at < now() - ($2 || ' hours')::interval
        AND COALESCE((
              SELECT COUNT(*) FROM ai_followup_touches t
               WHERE t.conversation_id = c.id
                 AND t.sent_at > COALESCE(li.at, '-infinity'::timestamptz)
            ), 0) < $3
      ORDER BY lm.created_at ASC
      LIMIT $4`,
    [channels, String(opts.delayHours), opts.maxTouches, cap],
  )

  return rows.map((r) => ({
    conversationId: r.id,
    managerId: r.manager_id,
    channelId: r.channel_id,
    channelType: r.channel_type,
    contactHandle: r.contact_handle,
    touchesInStreak: Number(r.touches_in_streak),
    lastMessageAt: new Date(r.last_message_at).toISOString(),
  }))
}

/** Record that a nudge was sent (feeds the streak cap + dedup guard). */
export async function recordFollowupTouch(input: {
  conversationId: string
  messageId: string | null
  touchNo: number
}): Promise<void> {
  await query(
    `INSERT INTO ai_followup_touches (conversation_id, message_id, touch_no)
     VALUES ($1, $2, $3)`,
    [input.conversationId, input.messageId, input.touchNo],
  )
}
