import { Client } from 'pg'
import { query, resolveSslConfig } from './db'

/**
 * Shared realtime hub.
 *
 * Postgres triggers fire `pg_notify('realtime', <json>)` for every message,
 * conversation and channel change (see scripts/003_engine.sql + 004_realtime.sql).
 *
 * Rather than opening one `LISTEN` connection per browser/widget — which would
 * exhaust Postgres connections under load — this module keeps a SINGLE long-
 * lived listener for the whole Node process and fans every event out to all
 * in-process subscribers. Each subscriber filters the stream itself (the panel
 * by managerId, the live-chat widget by channelId + visitor handle).
 *
 * The listener connects lazily on the first subscriber and reconnects with
 * backoff if the connection drops, so callers never deal with the raw client.
 */

export interface RealtimeEvent {
  type: 'message' | 'conversation' | 'channel' | 'typing' | 'presence'
  /**
   * For message events: 'insert' (new message) or 'update' (a message changed
   * in place — reaction toggled or soft-deleted). Absent for legacy/other
   * event types.
   */
  event?: 'insert' | 'update'
  /**
   * Typing events (ephemeral, NEVER stored in the DB — published straight via
   * pg_notify so they fan out across instances). `actor` says who is typing:
   * 'visitor' (live-chat guest → shown to the manager, may include a live
   * `draft`) or 'agent' (manager → shown in the widget as "<authorName>
   * печатает"). `typing` toggles the indicator on/off.
   */
  actor?: 'visitor' | 'agent'
  typing?: boolean
  draft?: string
  /**
   * Visitor presence on the website (live-chat only, ephemeral like typing —
   * NEVER stored). 'open' = widget open, 'minimized' = widget closed but still
   * on the page, 'away' = browser tab hidden, 'left' = navigated away/closed the
   * page. Fans out to the owning manager so the inbox can show live presence.
   */
  presence?: 'open' | 'minimized' | 'away' | 'left'
  authorName?: string
  managerId?: string
  channelId?: string
  channelType?: string
  conversationId?: string
  contactHandle?: string
  contactName?: string
  id?: string
  direction?: 'in' | 'out'
  body?: string
  author?: string
  createdAt?: string
  /** Emoji reactions on a message (message 'update' events). */
  reactions?: Array<{ emoji: string; fromMe: boolean }> | null
  /** Soft-delete marker (message 'update' events). */
  deletedAt?: string | null
  /** Who deleted the message: 'self' (operator) or 'remote' (the contact). */
  deletedOrigin?: 'self' | 'remote' | null
  /**
   * Channel session status (channel events) OR a message's delivery status
   * (message events: 'sent' | 'delivered' | 'read' | 'failed'). The shape is
   * disambiguated by `type`.
   */
  status?: string
  /** Failure reason for a message event whose status is 'failed'. */
  errorReason?: string | null
  sessionStatus?: string
  lastMessage?: string
  unread?: number
}

type Subscriber = (event: RealtimeEvent) => void

interface Hub {
  subscribers: Set<Subscriber>
  client: Client | null
  connecting: boolean
  reconnectTimer: ReturnType<typeof setTimeout> | null
  backoff: number
}

// Survive Next.js hot reloads / module duplication by stashing on globalThis.
const globalForRealtime = globalThis as unknown as { __realtimeHub?: Hub }

function hub(): Hub {
  if (!globalForRealtime.__realtimeHub) {
    globalForRealtime.__realtimeHub = {
      subscribers: new Set(),
      client: null,
      connecting: false,
      reconnectTimer: null,
      backoff: 1000,
    }
  }
  return globalForRealtime.__realtimeHub
}

function scheduleReconnect(h: Hub): void {
  if (h.reconnectTimer || h.subscribers.size === 0) return
  const delay = Math.min(h.backoff, 30_000)
  h.reconnectTimer = setTimeout(() => {
    h.reconnectTimer = null
    h.backoff = Math.min(h.backoff * 2, 30_000)
    void connect(h)
  }, delay)
}

async function connect(h: Hub): Promise<void> {
  if (h.client || h.connecting) return
  if (!process.env.DATABASE_URL) return
  // Guard against a reconnect timer firing after the last subscriber left:
  // without this we could open a LISTEN connection that nobody would ever
  // tear down (teardown only runs on unsubscribe), leaking it until the next
  // event. If there are no subscribers, there is nothing to fan out to.
  if (h.subscribers.size === 0) return
  h.connecting = true

  const connectionString = process.env.DATABASE_URL
  const client = new Client({
    connectionString,
    // Reuse the panel's single source of truth for TLS so the realtime
    // listener validates the server certificate exactly like every other
    // connection (see resolveSslConfig in ./db) instead of blindly trusting it.
    ssl: resolveSslConfig(connectionString),
  })

  client.on('notification', (msg) => {
    if (!msg.payload) return
    let event: RealtimeEvent
    try {
      event = JSON.parse(msg.payload) as RealtimeEvent
    } catch {
      return
    }
    for (const sub of h.subscribers) {
      try {
        sub(event)
      } catch {
        /* never let one bad subscriber break the fan-out */
      }
    }
  })

  client.on('error', () => {
    teardown(h)
    scheduleReconnect(h)
  })

  try {
    await client.connect()
    await client.query('LISTEN realtime')
    h.client = client
    h.backoff = 1000 // reset after a clean connect
  } catch {
    try {
      await client.end()
    } catch {
      /* ignore */
    }
    scheduleReconnect(h)
  } finally {
    h.connecting = false
  }
}

function teardown(h: Hub): void {
  const client = h.client
  h.client = null
  if (client) {
    client.removeAllListeners()
    client.end().catch(() => {})
  }
}

/**
 * Subscribe to realtime events. Returns an unsubscribe function. The shared
 * Postgres listener is started on the first subscriber and torn down when the
 * last one leaves.
 */
/**
 * Publish an ephemeral realtime event directly via `pg_notify` (the same
 * channel the DB triggers use), so it fans out to every subscriber across all
 * server instances without being persisted. Used for typing indicators, which
 * must never be written to the messages table. Best-effort: failures are
 * swallowed so a dropped typing ping never breaks the request that triggered it.
 */
export async function publishRealtime(event: RealtimeEvent): Promise<void> {
  try {
    await query('SELECT pg_notify($1, $2)', ['realtime', JSON.stringify(event)])
  } catch {
    /* typing is best-effort; never throw into the caller's request path */
  }
}

export function subscribeRealtime(onEvent: Subscriber): () => void {
  const h = hub()
  h.subscribers.add(onEvent)
  void connect(h)

  return () => {
    h.subscribers.delete(onEvent)
    if (h.subscribers.size === 0) {
      if (h.reconnectTimer) {
        clearTimeout(h.reconnectTimer)
        h.reconnectTimer = null
      }
      teardown(h)
    }
  }
}
