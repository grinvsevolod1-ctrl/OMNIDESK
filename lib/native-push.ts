import 'server-only'
import crypto from 'node:crypto'
import http2 from 'node:http2'
import { query } from './db'
import type { PushPayload } from './push'

/**
 * Native push for the Capacitor iOS/Android shell — APNs + FCM.
 *
 * WHY this exists next to push.ts: Apple does NOT deliver Web Push inside a
 * WKWebView, so the native iOS app cannot use the VAPID pipeline. iOS goes
 * through APNs, Android through FCM. This module mirrors push.ts's contracts:
 * it is env-gated (a no-op when unconfigured), prunes dead tokens, and NEVER
 * throws — notification delivery must never break message ingestion.
 *
 * Zero new runtime dependencies: the APNs provider JWT (ES256) and the FCM
 * service-account OAuth token (RS256) are both minted with node:crypto, and
 * APNs is spoken over node:http2 — matching push.ts's "stays inside our stack"
 * philosophy.
 *
 * Env (set on your VPS):
 *   APNs (iOS):
 *     APNS_KEY_P8      — contents of the AuthKey_XXXX.p8 file (BEGIN PRIVATE KEY…)
 *     APNS_KEY_ID      — the 10-char Key ID of that key
 *     APNS_TEAM_ID     — your 10-char Apple Team ID
 *     APNS_BUNDLE_ID   — the app bundle id (e.g. app.omnidesk.mobile)
 *     APNS_PRODUCTION  — "true" for the production APNs host, else sandbox
 *   FCM (Android):
 *     FCM_SERVICE_ACCOUNT_JSON — the full service-account JSON (one line)
 */

/* ------------------------------- config ---------------------------------- */

const APNS_KEY_P8 = (process.env.APNS_KEY_P8 || '').trim()
const APNS_KEY_ID = (process.env.APNS_KEY_ID || '').trim()
const APNS_TEAM_ID = (process.env.APNS_TEAM_ID || '').trim()
const APNS_BUNDLE_ID = (process.env.APNS_BUNDLE_ID || '').trim()
const APNS_HOST =
  (process.env.APNS_PRODUCTION || '').trim() === 'true'
    ? 'https://api.push.apple.com'
    : 'https://api.sandbox.push.apple.com'

interface FcmServiceAccount {
  project_id: string
  client_email: string
  private_key: string
}

function readFcmServiceAccount(): FcmServiceAccount | null {
  const raw = (process.env.FCM_SERVICE_ACCOUNT_JSON || '').trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<FcmServiceAccount>
    if (parsed.project_id && parsed.client_email && parsed.private_key) {
      return {
        project_id: parsed.project_id,
        client_email: parsed.client_email,
        // Env stores newlines as literal "\n"; restore them for the PEM parser.
        private_key: parsed.private_key.replace(/\\n/g, '\n'),
      }
    }
  } catch {
    /* fall through to null — treated as "FCM not configured" */
  }
  return null
}

const FCM_ACCOUNT = readFcmServiceAccount()

export function isApnsConfigured(): boolean {
  return Boolean(APNS_KEY_P8 && APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID)
}

export function isFcmConfigured(): boolean {
  return FCM_ACCOUNT !== null
}

/** True when at least one native transport can actually send. */
export function isNativePushConfigured(): boolean {
  return isApnsConfigured() || isFcmConfigured()
}

/* ----------------------------- token storage ----------------------------- */

export type DevicePlatform = 'ios' | 'android'

/** Persist (or refresh) a native device token for a manager/curator. */
export async function saveDeviceToken(
  managerId: string,
  platform: DevicePlatform,
  token: string,
  appVersion: string | null,
): Promise<void> {
  await query(
    `INSERT INTO device_push_tokens (manager_id, platform, token, app_version, last_used_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (token)
       DO UPDATE SET manager_id = $1, platform = $2, app_version = $4, last_used_at = now()`,
    [managerId, platform, token, appVersion],
  )
}

/** Remove a device token, scoped to its owner (logout / settings removal). */
export async function removeDeviceToken(
  managerId: string,
  token: string,
): Promise<void> {
  await query(
    'DELETE FROM device_push_tokens WHERE manager_id = $1 AND token = $2',
    [managerId, token],
  )
}

interface DeviceTokenRow {
  token: string
  platform: DevicePlatform
}

async function listDeviceTokens(managerId: string): Promise<DeviceTokenRow[]> {
  return query<DeviceTokenRow>(
    'SELECT token, platform FROM device_push_tokens WHERE manager_id = $1',
    [managerId],
  )
}

async function pruneDeadTokens(tokens: string[]): Promise<number> {
  if (tokens.length === 0) return 0
  try {
    await query('DELETE FROM device_push_tokens WHERE token = ANY($1)', [tokens])
    return tokens.length
  } catch {
    return 0
  }
}

/* ------------------------------ base64url -------------------------------- */

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

/* -------------------------------- APNs ----------------------------------- */

// The APNs provider token (ES256 JWT) is valid up to 60 min and Apple wants it
// reused, not minted per-push. Cache it and refresh a little early.
let apnsJwt: { token: string; mintedAt: number } | null = null

function getApnsJwt(): string {
  const now = Math.floor(Date.now() / 1000)
  if (apnsJwt && now - apnsJwt.mintedAt < 3000) return apnsJwt.token
  const header = b64url(JSON.stringify({ alg: 'ES256', kid: APNS_KEY_ID }))
  const claims = b64url(JSON.stringify({ iss: APNS_TEAM_ID, iat: now }))
  const signingInput = `${header}.${claims}`
  const signer = crypto.createSign('SHA256')
  signer.update(signingInput)
  // ieee-p1363 => the raw r||s form JOSE/ES256 requires (Node defaults to DER).
  const signature = signer.sign(
    { key: APNS_KEY_P8, dsaEncoding: 'ieee-p1363' },
    'base64url',
  )
  const token = `${signingInput}.${signature}`
  apnsJwt = { token, mintedAt: now }
  return token
}

type SendResult = 'sent' | 'dead' | 'error'

/**
 * Send one APNs push over a shared HTTP/2 session. `dead` means the token is
 * permanently gone (410 Unregistered / 400 BadDeviceToken) and should be pruned.
 */
function sendApns(
  session: http2.ClientHttp2Session,
  jwt: string,
  token: string,
  payload: PushPayload,
): Promise<SendResult> {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      aps: {
        alert: { title: payload.title, body: payload.body },
        sound: 'default',
        'thread-id': payload.tag ?? 'omnidesk',
      },
      url: payload.url,
      conversationId: payload.conversationId,
    })
    const req = session.request({
      ':method': 'POST',
      ':path': `/3/device/${token}`,
      authorization: `bearer ${jwt}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    })
    let status = 0
    let responseBody = ''
    req.setEncoding('utf8')
    req.on('response', (headers) => {
      status = Number(headers[':status']) || 0
    })
    req.on('data', (chunk) => {
      responseBody += chunk
    })
    req.on('error', () => resolve('error'))
    req.on('end', () => {
      if (status === 200) return resolve('sent')
      if (status === 410) return resolve('dead')
      if (status === 400 && /BadDeviceToken|BadCollapseId/.test(responseBody)) {
        return resolve('dead')
      }
      resolve('error')
    })
    req.end(body)
  })
}

async function sendApnsBatch(
  tokens: string[],
  payload: PushPayload,
): Promise<{ sent: number; dead: string[] }> {
  if (tokens.length === 0) return { sent: 0, dead: [] }
  const jwt = getApnsJwt()
  const session = http2.connect(APNS_HOST)
  const dead: string[] = []
  let sent = 0
  // Guard the whole batch so a hung socket can't wedge message ingestion.
  const closeSafely = () => {
    try {
      session.close()
    } catch {
      /* already closing */
    }
  }
  session.on('error', () => {
    /* connection-level failure: individual requests resolve 'error' */
  })
  try {
    const results = await Promise.all(
      tokens.map((t) =>
        sendApns(session, jwt, t, payload).then((r) => ({ token: t, r })),
      ),
    )
    for (const { token, r } of results) {
      if (r === 'sent') sent += 1
      else if (r === 'dead') dead.push(token)
    }
  } finally {
    closeSafely()
  }
  return { sent, dead }
}

/* --------------------------------- FCM ----------------------------------- */

let fcmToken: { token: string; expiresAt: number } | null = null

async function getFcmAccessToken(account: FcmServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  if (fcmToken && fcmToken.expiresAt - now > 60) return fcmToken.token

  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = b64url(
    JSON.stringify({
      iss: account.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  )
  const signingInput = `${header}.${claims}`
  const signer = crypto.createSign('RSA-SHA256')
  signer.update(signingInput)
  const signature = signer.sign(account.private_key, 'base64url')
  const assertion = `${signingInput}.${signature}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  })
  if (!res.ok) throw new Error(`FCM OAuth failed: ${res.status}`)
  const data = (await res.json()) as { access_token: string; expires_in: number }
  fcmToken = {
    token: data.access_token,
    expiresAt: now + (data.expires_in || 3600),
  }
  return data.access_token
}

async function sendFcm(
  account: FcmServiceAccount,
  accessToken: string,
  token: string,
  payload: PushPayload,
): Promise<SendResult> {
  try {
    const res = await fetch(
      `https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: payload.title, body: payload.body },
            data: {
              url: payload.url ?? '',
              tag: payload.tag ?? '',
              conversationId: payload.conversationId ?? '',
            },
            android: { priority: 'high', collapse_key: payload.tag },
          },
        }),
      },
    )
    if (res.ok) return 'sent'
    // UNREGISTERED (app uninstalled) / invalid token => prune.
    if (res.status === 404) return 'dead'
    if (res.status === 400) {
      const text = await res.text().catch(() => '')
      if (/UNREGISTERED|INVALID_ARGUMENT|registration-token/i.test(text)) {
        return 'dead'
      }
    }
    return 'error'
  } catch {
    return 'error'
  }
}

async function sendFcmBatch(
  tokens: string[],
  payload: PushPayload,
): Promise<{ sent: number; dead: string[] }> {
  if (tokens.length === 0 || !FCM_ACCOUNT) return { sent: 0, dead: [] }
  let accessToken: string
  try {
    accessToken = await getFcmAccessToken(FCM_ACCOUNT)
  } catch {
    return { sent: 0, dead: [] }
  }
  const dead: string[] = []
  let sent = 0
  const results = await Promise.all(
    tokens.map((t) =>
      sendFcm(FCM_ACCOUNT, accessToken, t, payload).then((r) => ({
        token: t,
        r,
      })),
    ),
  )
  for (const { token, r } of results) {
    if (r === 'sent') sent += 1
    else if (r === 'dead') dead.push(token)
  }
  return { sent, dead }
}

/* ------------------------------ public API ------------------------------- */

/**
 * Send a native push to every iOS/Android device a manager (or curator) has
 * registered. Routes each token to APNs or FCM by platform, prunes dead tokens,
 * and never throws — mirrors sendPushToManager in push.ts so the dispatcher can
 * fan out to both transports side by side.
 */
export async function sendNativePushToManager(
  managerId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!isNativePushConfigured()) return { sent: 0, pruned: 0 }

  let rows: DeviceTokenRow[]
  try {
    rows = await listDeviceTokens(managerId)
  } catch {
    return { sent: 0, pruned: 0 }
  }
  if (rows.length === 0) return { sent: 0, pruned: 0 }

  const iosTokens = rows.filter((r) => r.platform === 'ios').map((r) => r.token)
  const androidTokens = rows
    .filter((r) => r.platform === 'android')
    .map((r) => r.token)

  const [apnsRes, fcmRes] = await Promise.all([
    isApnsConfigured()
      ? sendApnsBatch(iosTokens, payload)
      : Promise.resolve({ sent: 0, dead: [] as string[] }),
    isFcmConfigured()
      ? sendFcmBatch(androidTokens, payload)
      : Promise.resolve({ sent: 0, dead: [] as string[] }),
  ])

  const pruned = await pruneDeadTokens([...apnsRes.dead, ...fcmRes.dead])
  return { sent: apnsRes.sent + fcmRes.sent, pruned }
}
