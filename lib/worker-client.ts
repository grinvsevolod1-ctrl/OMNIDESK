/**
 * Thin server-side client for the worker's internal HTTP API: health probes,
 * proxy checks, sticker palettes, and raw media streaming.
 *
 * Everything else (commands, status) flows through the Postgres job queue and
 * the channels table, so the panel and worker stay loosely coupled.
 */

import type { StickerItem } from './types'
import { envMs } from './with-deadline'

const WORKER_URL = process.env.WORKER_URL || 'http://127.0.0.1:4000'
const WORKER_SECRET = process.env.WORKER_SECRET || ''

export const isWorkerConfigured = Boolean(process.env.WORKER_SECRET)

/**
 * Every hop to the worker is bounded. The worker is a local process, so a
 * healthy reply is milliseconds; anything that takes longer than these means
 * the worker is wedged (stuck MTProto session, exhausted pool, unhandled
 * error that never ended the response) and the caller must fail instead of
 * pinning a browser request forever.
 *
 *  - WORKER_TIMEOUT_MS        JSON calls (health, stickers, qr, proxy check)
 *  - WORKER_POST_TIMEOUT_MS   personal sends: uploads to Telegram take longer
 *  - WORKER_MEDIA_TIMEOUT_MS  media/thumbnails: time until the worker sends
 *                             HEADERS (it buffers the whole download first)
 */
const WORKER_TIMEOUT_MS = envMs('WORKER_TIMEOUT_MS', 15_000)
const WORKER_POST_TIMEOUT_MS = envMs('WORKER_POST_TIMEOUT_MS', 90_000)
export const WORKER_MEDIA_TIMEOUT_MS = envMs('WORKER_MEDIA_TIMEOUT_MS', 45_000)

async function call<T>(path: string): Promise<T | null> {
  if (!isWorkerConfigured) return null
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      headers: { 'x-worker-secret': WORKER_SECRET },
      cache: 'no-store',
      signal: AbortSignal.timeout(WORKER_TIMEOUT_MS),
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Worker health probe (used by the connections page / settings). */
export async function workerHealth(): Promise<boolean> {
  const data = await call<{ ok: boolean }>('/health')
  return Boolean(data?.ok)
}

/* 15s TTL cache for the health probe: server pages render it on every
 * request, and an extra HTTP round-trip per page view buys nothing —
 * a worker flapping within 15 seconds is not actionable from the UI. */
let healthCache: { value: boolean; expires: number } | null = null

/** Cached variant of {@link workerHealth} for hot server-rendered pages. */
export async function workerHealthCached(): Promise<boolean> {
  const now = Date.now()
  if (healthCache && healthCache.expires > now) return healthCache.value
  const value = await workerHealth()
  healthCache = { value, expires: now + 15_000 }
  return value
}

export interface ProxyCheckResult {
  ok: boolean
  latencyMs?: number
  error?: string
  /** Per-destination reachability: MTProto DC tunnel + generic HTTPS. */
  reach?: { telegram: boolean; https: boolean }
}

/**
 * Ask the worker to test connectivity through a proxy by id. The worker loads
 * the (encrypted) proxy config from the DB, dials a probe URL through it, and
 * records the result on the proxies row.
 */
export async function checkProxy(
  proxyId: string,
): Promise<ProxyCheckResult | null> {
  return call<ProxyCheckResult>(
    `/proxy-check?proxyId=${encodeURIComponent(proxyId)}`,
  )
}

/**
 * Fetch the live Telegram QR-login deep link for a channel (present only while
 * a QR login is pending on the worker). Null when the worker isn't configured,
 * the session is missing, or no QR is pending.
 */
export async function fetchTelegramQr(
  channelId: string,
): Promise<{ qr: string | null; expiresAt: number | null } | null> {
  return call<{ qr: string | null; expiresAt: number | null }>(
    `/qr?channelId=${encodeURIComponent(channelId)}`,
  )
}

/**
 * Fetch the sticker palette (favourited + recent) for a Telegram channel.
 * Returns null when the worker isn't configured or the session is offline.
 */
export async function fetchStickers(
  channelId: string,
): Promise<StickerItem[] | null> {
  const data = await call<{ stickers: StickerItem[] }>(
    `/stickers?channelId=${encodeURIComponent(channelId)}`,
  )
  return data?.stickers ?? null
}

/**
 * Fetch a contact's Telegram profile photo bytes for the inbox avatar.
 * Returns the bytes on success, the string `'none'` when the contact has no
 * photo (a valid negative result the panel caches), or null when the worker
 * isn't configured / the session is offline / anything else went wrong.
 */
export async function fetchContactAvatar(
  channelId: string,
  peer: string,
): Promise<{ bytes: Buffer; mime: string } | 'none' | null> {
  if (!isWorkerConfigured) return null
  try {
    const res = await fetch(
      `${WORKER_URL}/contact-avatar?channelId=${encodeURIComponent(
        channelId,
      )}&peer=${encodeURIComponent(peer)}`,
      {
        headers: { 'x-worker-secret': WORKER_SECRET },
        cache: 'no-store',
        signal: AbortSignal.timeout(WORKER_MEDIA_TIMEOUT_MS),
      },
    )
    if (res.status === 404) return 'none'
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0) return 'none'
    return { bytes: buf, mime: res.headers.get('content-type') || 'image/jpeg' }
  } catch {
    return null
  }
}

/**
 * POST a JSON body to the worker's internal API and return the parsed JSON
 * reply. Null when the worker isn't configured or unreachable; отличать
 * "worker недоступен" от ошибки эндпоинта позволяет поле ok/error в ответе.
 */
export async function postJsonToWorker<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  if (!isWorkerConfigured) return null
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      method: 'POST',
      headers: {
        'x-worker-secret': WORKER_SECRET,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(WORKER_POST_TIMEOUT_MS),
    })
    return (await res.json()) as T
  } catch {
    return null
  }
}

/**
 * Proxy a raw binary GET to the worker (media bytes, sticker thumbnails) and
 * return the raw Response so the panel route can stream it straight to the
 * browser. Returns null when the worker isn't configured or unreachable.
 *
 * Bounded on HEADER arrival only: the timer is armed until the worker answers
 * and cleared the moment the Response resolves, so a large body still streams
 * to completion at whatever speed the client pulls it. When the worker never
 * answers we synthesize a 504 so the media route can hand the browser a real
 * error (which the tile turns into a retry) instead of a request that hangs
 * until the socket dies — the "loads forever" symptom.
 */
/**
 * Fetch a sticker's static raster preview (webp/png) from the worker so an
 * OUTGOING sticker can be archived at send time (see the send actions). Without
 * this, our own optimistic sticker row has no blob and no provider id, so
 * `/api/media/{id}` can serve nothing and the bubble degrades to the bare emoji
 * — the "I sent a sticker but see a smiley" bug. Returns the bytes + mime, or
 * null when the worker isn't configured / offline / the sticker can't be read.
 */
export async function fetchStickerThumb(
  channelId: string,
  sticker: { id: string; accessHash: string; fileReference: string },
): Promise<{ bytes: Buffer; mime: string } | null> {
  if (!isWorkerConfigured) return null
  try {
    const qs = new URLSearchParams({
      channelId,
      id: sticker.id,
      accessHash: sticker.accessHash,
      fileReference: sticker.fileReference,
    })
    const res = await fetch(`${WORKER_URL}/sticker-thumb?${qs.toString()}`, {
      headers: { 'x-worker-secret': WORKER_SECRET },
      cache: 'no-store',
      signal: AbortSignal.timeout(WORKER_MEDIA_TIMEOUT_MS),
    })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.byteLength === 0) return null
    return { bytes: buf, mime: res.headers.get('content-type') || 'image/webp' }
  } catch {
    return null
  }
}

export async function streamFromWorker(path: string): Promise<Response | null> {
  if (!isWorkerConfigured) return null
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), WORKER_MEDIA_TIMEOUT_MS)
  try {
    return await fetch(`${WORKER_URL}${path}`, {
      headers: { 'x-worker-secret': WORKER_SECRET },
      cache: 'no-store',
      signal: controller.signal,
    })
  } catch (err) {
    if (controller.signal.aborted) {
      console.error(
        `[worker-client] ${path} produced no headers within ${WORKER_MEDIA_TIMEOUT_MS}ms`,
      )
      return new Response('Worker timeout', {
        status: 504,
        headers: { 'cache-control': 'no-store' },
      })
    }
    console.error('[worker-client] stream failed:', err)
    return null
  } finally {
    clearTimeout(timer)
  }
}
