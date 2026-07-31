/**
 * Client-sim conversation I/O: channel selection, creating sim conversations, inbound messages, routing, and adopting/releasing the simulator's own dialogues.
 */

import {
  randomUUID,
} from 'node:crypto'
import {
  query,
} from '@/lib/db'
import {
  type ChannelType,
} from '@/lib/types'
import {
  type SimPersona,
  type SimPersonaConfig,
  type SimTone,
} from '../types'
import {
  inferGenderFromName,
  makePersona,
} from '../content'

/* --------------------------- conversation I/O --------------------------- */

/** Channels the bot may use: only those with an assigned manager. */
export interface SimChannel {
  id: string
  type: ChannelType
  managerId: string
}

export async function listUsableChannels(
  channelIds: string[],
): Promise<SimChannel[]> {
  const idFilter = channelIds.length ? channelIds : null
  const rows = await query<{ id: string; type: ChannelType; manager_id: string }>(
    `SELECT id, type, manager_id
       FROM channels
      WHERE manager_id IS NOT NULL
        AND ($1::uuid[] IS NULL OR id = ANY($1::uuid[]))`,
    [idFilter],
  )
  return rows.map((r) => ({ id: r.id, type: r.type, managerId: r.manager_id }))
}

/**
 * Create a brand-new conversation for a persona, seeded with its opening
 * message, and register the bot thread.
 *
 * This is deliberately byte-for-byte equivalent to how the WHATSAPP/TELEGRAM/VK
 * worker writes a genuine first inbound message (see worker/src/repo.ts):
 *   - `status` is left NULL (auto-derived as "new" from unread) — we must NOT
 *     set a literal status, both because real inbound leaves it NULL and
 *     because the post-035 CHECK constraint rejects legacy values like 'new'.
 *   - `contact_username` is populated for telegram/vk just like the real path.
 *   - the conversation is seeded with the first message body + unread=1 in one
 *     shot, so it never flashes into the manager's list as an empty thread.
 * The result is indistinguishable from an organic incoming conversation.
 */
export async function createSimConversation(
  channel: SimChannel,
  persona: SimPersona,
  firstBody: string,
): Promise<string> {
  const convId = randomUUID()
  const contactUsername = persona.username ?? null
  // is_simulated = true is what keeps this dialog OUT of the normal manager
  // inbox and analytics (migration 065) — it lives only in the secret panel.
  await query(
    `INSERT INTO conversations
       (id, channel_id, channel_type, manager_id, contact_name, contact_handle,
        contact_username, last_message, last_message_at, unread, is_simulated)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), 1, true)`,
    [
      convId,
      channel.id,
      channel.type,
      channel.managerId,
      persona.name,
      persona.username ? `@${persona.username}` : persona.handle,
      contactUsername,
      firstBody,
    ],
  )
  await query(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, 'in', $3, $4)`,
    [randomUUID(), convId, firstBody, persona.name],
  )
  await query(
    `INSERT INTO sim_threads (conversation_id, channel_id, persona, state, next_run_at)
     VALUES ($1, $2, $3::jsonb, 'opening', now())`,
    [convId, channel.id, JSON.stringify(persona)],
  )
  return convId
}

/**
 * Insert an inbound (client) message exactly like secretSendAsClientAction —
 * same tables + triggers, so the manager sees it arrive live and it is
 * completely indistinguishable from a genuine incoming message.
 */
export async function insertInboundMessage(
  conversationId: string,
  author: string,
  body: string,
): Promise<void> {
  await query(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, 'in', $3, $4)`,
    [randomUUID(), conversationId, body, author],
  )
  await query(
    `UPDATE conversations
        SET last_message = $2, last_message_at = now(), unread = unread + 1
      WHERE id = $1`,
    [conversationId, body],
  )
}

/**
 * Manager + channel a conversation routes to. Needed so the simulator can hand
 * a freshly-posted client message to the AI MANAGER through its normal public
 * entry point (exactly like a real channel webhook would), instead of poking at
 * the manager's brain directly — the two systems stay code-separate.
 */
export async function getConversationRouting(
  conversationId: string,
): Promise<{ managerId: string; channelId: string } | null> {
  const rows = await query<{ manager_id: string; channel_id: string }>(
    `SELECT manager_id, channel_id FROM conversations WHERE id = $1`,
    [conversationId],
  )
  const r = rows[0]
  return r ? { managerId: r.manager_id, channelId: r.channel_id } : null
}

/* ---------------- re-adopting the simulator's OWN dialogues -------------- */
/*
 * The simulator only ever touches conversations IT created (is_simulated = true
 * with a row in sim_threads). Everything else — every real, organic dialogue
 * from a genuine human — is completely invisible to the engine and can NEVER be
 * adopted. This is a hard safety rule: the bot must never continue a real
 * person's chat (that caused the "client said 15, bot replied 51" contradiction
 * and other identity clashes). "Re-adopting" only re-registers a sim_threads row
 * for a simulated dialog that lost one (e.g. its thread was closed), so the
 * engine keeps that same fake persona going on a human, randomised schedule.
 */

export interface AdoptableConversation {
  id: string
  channelType: ChannelType
  contactName: string
  managerId: string | null
  managerName: string | null
  lastMessage: string | null
  lastMessageAt: string | null
  messageCount: number
  /** Who spoke last: 'in' = client, 'out' = manager. */
  lastDirection: 'in' | 'out' | null
  /** Already registered as a simulator thread. */
  adopted: boolean
}

/**
 * List the simulator's OWN dialogs that could be re-adopted: only simulated
 * conversations (is_simulated = true). Real human dialogs are excluded so the
 * bot can never be pointed at a genuine person. Each row carries the owning
 * manager's name, a message count, the last message + who sent it, and whether
 * it is already adopted. Ordered newest-activity first.
 */
export async function listAdoptableConversations(
  limit = 1000,
): Promise<AdoptableConversation[]> {
  const rows = await query<{
    id: string
    channel_type: ChannelType
    contact_name: string | null
    manager_id: string | null
    manager_name: string | null
    last_message: string | null
    last_message_at: string | Date | null
    msg_count: number
    last_direction: 'in' | 'out' | null
    adopted: boolean
  }>(
    `SELECT c.id, c.channel_type, c.contact_name, c.manager_id,
            mgr.name AS manager_name,
            c.last_message, c.last_message_at,
            COALESCE(mc.n, 0) AS msg_count,
            lm.direction AS last_direction,
            (st.conversation_id IS NOT NULL) AS adopted
       FROM conversations c
       LEFT JOIN managers mgr ON mgr.id = c.manager_id
       LEFT JOIN sim_threads st ON st.conversation_id = c.id
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n
           FROM messages m
          WHERE m.conversation_id = c.id
       ) mc ON true
       LEFT JOIN LATERAL (
         SELECT direction
           FROM messages m
          WHERE m.conversation_id = c.id
          ORDER BY created_at DESC
          LIMIT 1
       ) lm ON true
      WHERE c.manager_id IS NOT NULL
        AND c.is_simulated = true
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $1`,
    [Math.max(1, limit)],
  )
  return rows.map((r) => ({
    id: r.id,
    channelType: r.channel_type,
    contactName: r.contact_name ?? 'Без имени',
    managerId: r.manager_id,
    managerName: r.manager_name,
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at
      ? new Date(r.last_message_at).toISOString()
      : null,
    messageCount: Number(r.msg_count ?? 0),
    lastDirection: r.last_direction,
    adopted: r.adopted,
  }))
}

export interface AdoptResult {
  adopted: number
  skipped: number
}

/**
 * Register simulator threads for the given existing conversations so the engine
 * continues them. For each conversation we:
 *   - synthesize a fresh random persona (tone/character rolled from settings)
 *     but pin its NAME/handle to the real contact, so the same person keeps
 *     talking rather than a stranger;
 *   - seed `turns` from the real client-message count so behaviour escalation
 *     picks up where the dialogue actually is;
 *   - pin `last_seen_out` to the latest manager message so the reaction sweep
 *     doesn't instantly fire on an old reply — we drive timing ourselves;
 *   - schedule `next_run_at` at a RANDOM offset within [minDelaySec, maxDelaySec]
 *     so the swarm revives dialogues staggered over time, never all at once.
 * Already-adopted conversations are skipped (idempotent via ON CONFLICT).
 */
export async function adoptConversations(
  conversationIds: string[],
  opts: {
    aggression: number
    tone: SimTone
    minDelaySec?: number
    maxDelaySec?: number
    /** Persona pools from sim_settings.content_config.persona — optional, falls back to hardcoded defaults. */
    personaCfg?: SimPersonaConfig | null
  },
): Promise<AdoptResult> {
  const ids = [...new Set(conversationIds)].filter(Boolean)
  if (ids.length === 0) return { adopted: 0, skipped: 0 }

  const seeds = await query<{
    id: string
    channel_id: string
    channel_type: ChannelType
    contact_name: string | null
    contact_handle: string | null
    contact_username: string | null
    last_out_id: string | null
    client_turns: number
    already: boolean
  }>(
    `SELECT c.id, c.channel_id, c.channel_type,
            c.contact_name, c.contact_handle, c.contact_username,
            lo.id AS last_out_id,
            COALESCE(ct.n, 0) AS client_turns,
            (st.conversation_id IS NOT NULL) AS already
       FROM conversations c
       LEFT JOIN sim_threads st ON st.conversation_id = c.id
       LEFT JOIN LATERAL (
         SELECT id
           FROM messages m
          WHERE m.conversation_id = c.id AND m.direction = 'out'
          ORDER BY created_at DESC
          LIMIT 1
       ) lo ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS n
           FROM messages m
          WHERE m.conversation_id = c.id AND m.direction = 'in'
       ) ct ON true
      WHERE c.id = ANY($1::uuid[])
        AND c.manager_id IS NOT NULL
        AND c.is_simulated = true`,
    [ids],
  )

  const minD = Math.max(5, Math.floor(opts.minDelaySec ?? 20))
  const maxD = Math.max(minD + 1, Math.floor(opts.maxDelaySec ?? 7200))

  let adopted = 0
  let skipped = 0
  for (const s of seeds) {
    if (s.already) {
      skipped += 1
      continue
    }
    const persona = makePersona(s.channel_type, opts.aggression, opts.tone, opts.personaCfg)
    // Pin identity to the real contact so it reads as the same person.
    if (s.contact_name) persona.name = s.contact_name
    if (s.contact_handle) persona.handle = s.contact_handle
    persona.username = s.contact_username ?? persona.username
    // Keep gender consistent with the pinned name so the persona never
    // contradicts itself (e.g. «Наталья» rolled as male). Falls back to the
    // randomly-rolled gender when the name is genderless (a bare @nick).
    const inferred = inferGenderFromName(s.contact_name)
    if (inferred) persona.gender = inferred

    const delay = minD + Math.floor(Math.random() * (maxD - minD))
    await query(
      `INSERT INTO sim_threads
         (conversation_id, channel_id, persona, state, turns, last_seen_out, next_run_at)
       VALUES ($1, $2, $3::jsonb, 'chatting', $4, $5, now() + make_interval(secs => $6::int))
       ON CONFLICT (conversation_id) DO NOTHING`,
      [
        s.id,
        s.channel_id,
        JSON.stringify(persona),
        Math.max(1, Number(s.client_turns ?? 1)),
        s.last_out_id,
        delay,
      ],
    )
    adopted += 1
  }
  // Any requested id not returned by the seed query (no manager / not found) is
  // counted as skipped so the UI total always reconciles.
  skipped += ids.length - seeds.length
  return { adopted, skipped }
}

/**
 * Stop the simulator from driving the given conversations — the inverse of
 * {@link adoptConversations}. We simply delete their `sim_threads` rows: the
 * engine's due-sweep and reaction-sweep both read exclusively from that table,
 * so once the row is gone the bot never touches the conversation again.
 *
 * The real conversation and ALL of its messages are left completely intact, so
 * releasing an adopted real dialogue just hands it back to the human manager
 * with its full history. Returns how many threads were actually removed.
 */
export async function releaseConversations(
  conversationIds: string[],
): Promise<{ released: number }> {
  const ids = [...new Set(conversationIds)].filter(Boolean)
  if (ids.length === 0) return { released: 0 }
  const rows = await query<{ conversation_id: string }>(
    `DELETE FROM sim_threads
      WHERE conversation_id = ANY($1::uuid[])
      RETURNING conversation_id`,
    [ids],
  )
  return { released: rows.length }
}

/** Recent transcript for building LLM context (oldest→newest). */
