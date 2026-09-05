import 'server-only'
import webpush, { type PushSubscription } from 'web-push'
import { query } from './db'

/**
 * Web Push (browser + mobile) for manager notifications.
 *
 * This stays entirely inside the existing stack — no third-party push service.
 * The standard Web Push protocol (VAPID) is used: the browser subscribes to its
 * own push service (FCM/APNs/Mozilla autopush, chosen by the browser) and hands
 * us an encrypted endpoint, which we store in `push_subscriptions` and deliver
 * to via the `web-push` library.
 *
 * Configuration is read from env (set these on your VPS):
 *   VAPID_PUBLIC_KEY   — shared with the browser as the applicationServerKey
 *   VAPID_PRIVATE_KEY  — kept server-side only, signs each push
 *   VAPID_SUBJECT      — a mailto: or https: contact, required by the spec
 */

const VAPID_PUBLIC_KEY = (process.env.VAPID_PUBLIC_KEY || '').trim()
const VAPID_PRIVATE_KEY = (process.env.VAPID_PRIVATE_KEY || '').trim()
const VAPID_SUBJECT =
  (process.env.VAPID_SUBJECT || '').trim() || 'mailto:admin@omnidesk.local'

let configured = false

/** True when VAPID keys are present, i.e. push can actually be sent. */
export function isPushConfigured(): boolean {
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY)
}

/** The public key the client needs to call pushManager.subscribe(). */
export function getVapidPublicKey(): string {
  return VAPID_PUBLIC_KEY
}

function ensureConfigured(): boolean {
  if (!isPushConfigured()) return false
  if (!configured) {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
    configured = true
  }
  return true
}

export interface StoredSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

/** Persist (or refresh) a browser subscription for a manager. */
export async function saveSubscription(
  managerId: string,
  sub: StoredSubscription,
  userAgent: string | null,
): Promise<void> {
  await query(
    `INSERT INTO push_subscriptions (manager_id, endpoint, p256dh, auth, user_agent, last_used_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (endpoint)
       DO UPDATE SET manager_id = $1, p256dh = $3, auth = $4, user_agent = $5, last_used_at = now()`,
    [managerId, sub.endpoint, sub.p256dh, sub.auth, userAgent],
  )
}

export interface SubscriptionInfo {
  endpoint: string
  userAgent: string | null
  lastUsedAt: string | null
}

/**
 * List a manager's registered devices (settings-page diagnostics). Endpoints
 * are opaque push-service URLs, not secrets, and the list is scoped to the
 * signed-in manager — the client marks "this device" by comparing with its
 * own subscription endpoint.
 */
export async function listManagerSubscriptions(
  managerId: string,
): Promise<SubscriptionInfo[]> {
  const rows = await query<{
    endpoint: string
    user_agent: string | null
    last_used_at: string | null
  }>(
    `SELECT endpoint, user_agent, last_used_at
       FROM push_subscriptions
      WHERE manager_id = $1
      ORDER BY last_used_at DESC NULLS LAST`,
    [managerId],
  )
  return rows.map((r) => ({
    endpoint: r.endpoint,
    userAgent: r.user_agent,
    lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
  }))
}

/** Remove a subscription by endpoint (manager-scoped for safety). */
export async function removeSubscription(
  managerId: string,
  endpoint: string,
): Promise<void> {
  await query(
    'DELETE FROM push_subscriptions WHERE manager_id = $1 AND endpoint = $2',
    [managerId, endpoint],
  )
}

/**
 * Remove a manager subscription by endpoint ALONE — used by the service
 * worker's identity gate (/api/push/detach) on a device where the session has
 * ended: there is no `manager_id` to scope by because nobody is signed in.
 * Safe without a session because a push endpoint is an unguessable capability
 * URL — possessing it proves you are that device, and the only power granted is
 * to stop that device's own deliveries (self-service, never data exposure).
 */
export async function removeSubscriptionByEndpoint(
  endpoint: string,
): Promise<void> {
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint])
}

interface SubscriptionRow {
  endpoint: string
  p256dh: string
  auth: string
}

async function listSubscriptions(
  managerId: string,
): Promise<SubscriptionRow[]> {
  return query<SubscriptionRow>(
    'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE manager_id = $1',
    [managerId],
  )
}

/* ------------------------- Website-visitor push --------------------------- */

/**
 * Persist (or refresh) a website visitor's push subscription, scoped to a
 * channel + visitor handle (instead of a manager). Captured by the /c/<apiKey>
 * page on our own origin, since the widget's own (customer) origin can't
 * subscribe to our push.
 */
export async function saveVisitorSubscription(
  channelId: string,
  contactHandle: string,
  sub: StoredSubscription,
  userAgent: string | null,
): Promise<void> {
  await query(
    `INSERT INTO visitor_push_subscriptions
       (channel_id, contact_handle, endpoint, p256dh, auth, user_agent, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $6, now())
     ON CONFLICT (endpoint)
       DO UPDATE SET channel_id = $1, contact_handle = $2, p256dh = $4,
                     auth = $5, user_agent = $6, last_used_at = now()`,
    [channelId, contactHandle, sub.endpoint, sub.p256dh, sub.auth, userAgent],
  )
}

/**
 * Send a push to every device a website visitor registered for one conversation
 * (channel + visitor handle). Same dead-endpoint pruning as the manager path.
 * Never throws.
 */
export async function sendPushToVisitor(
  channelId: string,
  contactHandle: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!ensureConfigured()) return { sent: 0, pruned: 0 }

  let subs: SubscriptionRow[]
  try {
    subs = await query<SubscriptionRow>(
      `SELECT endpoint, p256dh, auth FROM visitor_push_subscriptions
        WHERE channel_id = $1 AND contact_handle = $2`,
      [channelId, contactHandle],
    )
  } catch {
    return { sent: 0, pruned: 0 }
  }
  if (subs.length === 0) return { sent: 0, pruned: 0 }

  const body = JSON.stringify(payload)
  let sent = 0
  let pruned = 0
  const dead: string[] = []

  await Promise.all(
    subs.map(async (row) => {
      const subscription: PushSubscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }
      try {
        await webpush.sendNotification(subscription, body, { TTL: 120 })
        sent += 1
      } catch (err: unknown) {
        const statusCode =
          typeof err === 'object' && err && 'statusCode' in err
            ? (err as { statusCode?: number }).statusCode
            : undefined
        if (statusCode === 404 || statusCode === 410) dead.push(row.endpoint)
      }
    }),
  )

  if (dead.length > 0) {
    try {
      await query(
        'DELETE FROM visitor_push_subscriptions WHERE endpoint = ANY($1)',
        [dead],
      )
      pruned = dead.length
    } catch {
      /* ignore prune failure */
    }
  }

  return { sent, pruned }
}

/* --------------------------- God-messenger push --------------------------- */

/**
 * Persist (or refresh) a god-messenger device subscription. Unlike the manager
 * table this has no owner scope — the god panel is a single super-admin surface,
 * so every subscribed device receives every god push. Keyed by endpoint so a
 * re-subscribe from the same device updates in place.
 */
export async function saveGodSubscription(
  sub: StoredSubscription,
  userAgent: string | null,
): Promise<void> {
  await query(
    `INSERT INTO god_push_subscriptions (endpoint, p256dh, auth, user_agent, last_used_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (endpoint)
       DO UPDATE SET p256dh = $2, auth = $3, user_agent = $4, last_used_at = now()`,
    [sub.endpoint, sub.p256dh, sub.auth, userAgent],
  )
}

/** Remove a god-messenger subscription by endpoint. */
export async function removeGodSubscription(endpoint: string): Promise<void> {
  await query('DELETE FROM god_push_subscriptions WHERE endpoint = $1', [
    endpoint,
  ])
}

/** True when at least one god device is subscribed. */
export async function hasGodSubscriptions(): Promise<boolean> {
  try {
    const rows = await query<{ one: number }>(
      'SELECT 1 AS one FROM god_push_subscriptions LIMIT 1',
    )
    return rows.length > 0
  } catch {
    return false
  }
}

/**
 * Send a push to EVERY god-messenger device. Same dead-endpoint pruning and
 * never-throws contract as the manager path. Used when a manager replies in any
 * conversation, so the god-admin is notified on their phone.
 */
export async function sendPushToGod(
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!ensureConfigured()) return { sent: 0, pruned: 0 }

  let subs: SubscriptionRow[]
  try {
    subs = await query<SubscriptionRow>(
      'SELECT endpoint, p256dh, auth FROM god_push_subscriptions',
    )
  } catch {
    return { sent: 0, pruned: 0 }
  }
  if (subs.length === 0) return { sent: 0, pruned: 0 }

  const body = JSON.stringify(payload)
  let sent = 0
  let pruned = 0
  const dead: string[] = []

  await Promise.all(
    subs.map(async (row) => {
      const subscription: PushSubscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }
      try {
        await webpush.sendNotification(subscription, body, { TTL: 120 })
        sent += 1
      } catch (err: unknown) {
        const statusCode =
          typeof err === 'object' && err && 'statusCode' in err
            ? (err as { statusCode?: number }).statusCode
            : undefined
        if (statusCode === 404 || statusCode === 410) dead.push(row.endpoint)
      }
    }),
  )

  if (dead.length > 0) {
    try {
      await query(
        'DELETE FROM god_push_subscriptions WHERE endpoint = ANY($1)',
        [dead],
      )
      pruned = dead.length
    } catch {
      /* ignore prune failure */
    }
  }

  return { sent, pruned }
}

export interface PushPayload {
  title: string
  body: string
  /**
   * The operator this push is addressed to (manager/curator id). The service
   * worker compares it against the device's CURRENT session (/api/push/whoami)
   * and refuses to show the notification when the session is gone or belongs to
   * a different user — closing the "logged out but still getting notifications"
   * leak. Omitted for security alerts and visitor/god pushes, which are always
   * shown (they carry their own auth or target a separate subscription table).
   */
  userId?: string
  /** Where to navigate when the notification is clicked. */
  url?: string
  /** Collapse key so repeat messages from one chat replace each other. */
  tag?: string
  /**
   * 'security' renders action buttons («Да, это я» / «Разлогинить все») in
   * the service worker instead of the plain open-inbox behavior.
   */
  kind?: 'security'
  /** Signed token the kick button POSTs to /api/security/kick. */
  kickToken?: string
  /**
   * Inbound-message pushes set this so the service worker can offer an inline
   * "reply" action (type:'text'): the worker POSTs the typed text to
   * /api/push/reply with the session cookie. Undefined = no reply affordance
   * (security alerts, visitor/god pushes).
   */
  conversationId?: string
  /**
   * Which authenticated surface should send the reply — 'manager' routes to the
   * manager send action, 'curator' to the curator-scoped one. Mirrors the
   * dispatcher's targetUrl decision so the reply is sent by the same identity
   * that received the push.
   */
  replyRole?: 'manager' | 'curator'
}

export type EndpointPushResult =
  /** Delivered to the push service for this exact device. */
  | 'sent'
  /** No row for this endpoint on the server — the device is not registered. */
  | 'missing'
  /** The push service rejected the subscription (dead/stale) — row pruned. */
  | 'rejected'
  /** Transient failure (5xx/network); subscription kept. */
  | 'error'

/**
 * Send a push to ONE specific device (endpoint) of a manager and report what
 * actually happened to THAT device. The broadcast path (sendPushToManager)
 * can only say "delivered somewhere", which made the settings-page test
 * useless for diagnosing a single broken computer: it reported success when
 * another device received the push. Endpoint is manager-scoped so one manager
 * can't probe another's subscriptions.
 */
export async function sendPushToEndpoint(
  managerId: string,
  endpoint: string,
  payload: PushPayload,
): Promise<EndpointPushResult> {
  if (!ensureConfigured()) return 'error'

  let rows: SubscriptionRow[]
  try {
    rows = await query<SubscriptionRow>(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions
        WHERE manager_id = $1 AND endpoint = $2`,
      [managerId, endpoint],
    )
  } catch {
    return 'error'
  }
  const row = rows[0]
  if (!row) return 'missing'

  const subscription: PushSubscription = {
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
  }
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload), {
      TTL: 60,
    })
    return 'sent'
  } catch (err: unknown) {
    const statusCode =
      typeof err === 'object' && err && 'statusCode' in err
        ? (err as { statusCode?: number }).statusCode
        : undefined
    if (
      statusCode === 400 ||
      statusCode === 401 ||
      statusCode === 403 ||
      statusCode === 404 ||
      statusCode === 410
    ) {
      // Dead or key-mismatched subscription: prune so the client's next
      // ensurePushSubscription recreates it cleanly.
      await query(
        'DELETE FROM push_subscriptions WHERE manager_id = $1 AND endpoint = $2',
        [managerId, endpoint],
      ).catch(() => {})
      console.warn(
        `[push] Test delivery rejected (HTTP ${statusCode}) for manager ${managerId}; subscription pruned.`,
      )
      return 'rejected'
    }
    console.warn(
      `[push] Test delivery failed (HTTP ${statusCode ?? '?'}) for manager ${managerId}; keeping subscription.`,
    )
    return 'error'
  }
}

/**
 * Send a push to every device a manager has registered. Subscriptions that the
 * push service reports as gone (404/410) are pruned automatically so we don't
 * keep retrying dead endpoints (which would be wasted work, not a ban risk).
 * Never throws — notification delivery must never break message ingestion.
 */
export async function sendPushToManager(
  managerId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!ensureConfigured()) return { sent: 0, pruned: 0 }

  let subs: SubscriptionRow[]
  try {
    subs = await listSubscriptions(managerId)
  } catch {
    return { sent: 0, pruned: 0 }
  }
  if (subs.length === 0) return { sent: 0, pruned: 0 }

  const body = JSON.stringify(payload)
  let sent = 0
  let pruned = 0
  const dead: string[] = []

  await Promise.all(
    subs.map(async (row) => {
      const subscription: PushSubscription = {
        endpoint: row.endpoint,
        keys: { p256dh: row.p256dh, auth: row.auth },
      }
      try {
        await webpush.sendNotification(subscription, body, { TTL: 60 })
        sent += 1
      } catch (err: unknown) {
        const statusCode =
          typeof err === 'object' && err && 'statusCode' in err
            ? (err as { statusCode?: number }).statusCode
            : undefined
        if (statusCode === 404 || statusCode === 410) {
          dead.push(row.endpoint)
          return
        }
        if (statusCode === 400 || statusCode === 401 || statusCode === 403) {
          // Signature/key rejection — the classic symptom of a VAPID key
          // rotation: the browser's subscription was created with the OLD
          // key, so every delivery is refused. Prune it; the client
          // re-subscribes with the current key on its next panel load
          // (ensurePushSubscription drops key-mismatched subscriptions).
          dead.push(row.endpoint)
          console.warn(
            `[push] Delivery rejected (HTTP ${statusCode}) for manager ${managerId} — ` +
              'likely a subscription from an old VAPID key. Pruned; it will be ' +
              'recreated when the manager next opens the panel.',
          )
          return
        }
        // Anything else (5xx from the push service, network): transient —
        // keep the subscription, but leave a trace instead of failing mute.
        console.warn(
          `[push] Delivery failed (HTTP ${statusCode ?? '?'}) for manager ${managerId}; keeping subscription.`,
        )
      }
    }),
  )

  if (dead.length > 0) {
    try {
      await query('DELETE FROM push_subscriptions WHERE endpoint = ANY($1)', [
        dead,
      ])
      pruned = dead.length
    } catch {
      /* ignore prune failure */
    }
  }

  return { sent, pruned }
}
