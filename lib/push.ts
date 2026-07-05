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

export interface PushPayload {
  title: string
  body: string
  /** Where to navigate when the notification is clicked. */
  url?: string
  /** Collapse key so repeat messages from one chat replace each other. */
  tag?: string
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
        }
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
