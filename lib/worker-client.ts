/**
 * Thin server-side client for the worker's internal HTTP API. Used only for
 * things that can't live in the DB — primarily the live WhatsApp QR which is
 * held in the worker's memory while a scan is pending.
 *
 * Everything else (commands, status) flows through the Postgres job queue and
 * the channels table, so the panel and worker stay loosely coupled.
 */

import type { StickerItem } from './types'

const WORKER_URL = process.env.WORKER_URL || 'http://127.0.0.1:4000'
const WORKER_SECRET = process.env.WORKER_SECRET || ''

export const isWorkerConfigured = Boolean(process.env.WORKER_SECRET)

async function call<T>(path: string): Promise<T | null> {
  if (!isWorkerConfigured) return null
  try {
    const res = await fetch(`${WORKER_URL}${path}`, {
      headers: { 'x-worker-secret': WORKER_SECRET },
      cache: 'no-store',
    })
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

/** Fetch the current WhatsApp QR (data-URL) for a channel, if any. */
export async function fetchQr(channelId: string): Promise<string | null> {
  const data = await call<{ qr: string | null }>(
    `/qr?channelId=${encodeURIComponent(channelId)}`,
  )
  return data?.qr ?? null
}

/** Fetch the current WhatsApp pairing code for a channel, if any. */
export async function fetchPairingCode(
  channelId: string,
): Promise<string | null> {
  const data = await call<{ code: string | null }>(
    `/pairing-code?channelId=${encodeURIComponent(channelId)}`,
  )
  return data?.code ?? null
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
  /** Per-destination reachability (socks5/http proxies). */
  reach?: { telegram: boolean; whatsapp: boolean }
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
 * Proxy a raw binary GET to the worker (media bytes, sticker thumbnails) and
 * return the raw Response so the panel route can stream it straight to the
 * browser. Returns null when the worker isn't configured.
 */
export async function streamFromWorker(path: string): Promise<Response | null> {
  if (!isWorkerConfigured) return null
  try {
    return await fetch(`${WORKER_URL}${path}`, {
      headers: { 'x-worker-secret': WORKER_SECRET },
      cache: 'no-store',
    })
  } catch {
    return null
  }
}
