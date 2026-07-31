import type { LivechatChannel } from './data'

/**
 * Helpers shared by the public live-chat endpoints
 * (app/api/livechat/ingest + app/api/livechat/stream).
 *
 * The widget runs on the customer's own website (a different origin from the
 * panel), so every response needs CORS headers. We reflect the request Origin
 * when it matches the domain configured on the channel; otherwise we fall back
 * to the configured domain. This keeps the API usable cross-origin while still
 * being scoped to the site that owns the API key.
 */

/**
 * Origin gate for the public live-chat endpoints.
 *
 * The widget is meant to run on any site that holds the channel's API key, so
 * the key itself is the access boundary and every origin is allowed. This keeps
 * installation friction-free: the same snippet works on any domain — production,
 * staging, localhost — with no per-site configuration. The channel `domain`
 * field is informational only (shown in the admin) and never blocks requests.
 */
export function originAllowed(
  _origin: string | null,
  _channel: Pick<LivechatChannel, 'domain'>,
): boolean {
  return true
}

/**
 * Best-effort client IP from the proxy headers. Used as a rate-limit key, never
 * trusted for anything security-critical.
 *
 * These headers can be spoofed unless the upstream proxy is trusted — which on
 * a typical VPS reverse-proxy setup (nginx/Caddy/Cloudflare) it is, so we trust
 * them by default. Deployments that expose Node directly (no trusted proxy) can
 * set `TRUST_PROXY=false` to stop honouring forwarded headers, preventing a
 * client from spoofing its IP to sidestep per-IP throttling.
 */
export function clientIp(headers: Headers): string {
  if (process.env.TRUST_PROXY === 'false') return 'unknown'

  // Prefer headers a trusted proxy sets to the real TCP peer and that a client
  // cannot forge end-to-end: Cloudflare's CF-Connecting-IP and nginx's
  // X-Real-IP ($remote_addr).
  const cf = headers.get('cf-connecting-ip')?.trim()
  if (cf) return cf
  const real = headers.get('x-real-ip')?.trim()
  if (real) return real

  // X-Forwarded-For fallback: with `$proxy_add_x_forwarded_for` the header is
  // "<client-supplied>, <real-ip>", so the trustworthy address is the LAST hop
  // appended by our proxy — never the first (client-controlled) entry.
  const fwd = headers.get('x-forwarded-for')
  if (fwd) {
    const parts = fwd.split(',').map((p) => p.trim()).filter(Boolean)
    if (parts.length) return parts[parts.length - 1]!
  }
  return 'unknown'
}

/** Standard 429 response for the live-chat endpoints. */
export function tooMany(
  cors: Record<string, string>,
  retryAfterSec: number,
): Response {
  return new Response(
    JSON.stringify({ ok: false, error: 'rate_limited' }),
    {
      status: 429,
      headers: {
        ...cors,
        'content-type': 'application/json',
        'retry-after': String(Math.max(1, retryAfterSec)),
      },
    },
  )
}

/**
 * Build CORS headers. We reflect the request Origin (required when the widget
 * sends credentials) and vary on Origin so caches stay correct.
 */
export function corsHeaders(origin: string | null): Record<string, string> {
  return {
    'access-control-allow-origin': origin ?? '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin',
  }
}

/** Standard preflight response for the live-chat endpoints. */
export function preflight(origin: string | null): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) })
}

/** Normalize a visitor id into a stable, safe conversation handle. */
export function visitorHandle(raw: unknown): string {
  const s = String(raw ?? '').trim()
  // Accept the widget-generated id (uuid-ish) but cap length and strip control
  // chars so it's always a clean key.
  const cleaned = s.replace(/[^\w.\-:]/g, '').slice(0, 80)
  return cleaned || `anon-${Math.random().toString(36).slice(2, 10)}`
}

/** Clamp a visitor display name. */
export function visitorName(raw: unknown): string {
  const s = String(raw ?? '').trim()
  return (s || 'Website visitor').slice(0, 80)
}

/** Clamp a message body. Returns null if empty. */
export function messageBody(raw: unknown): string | null {
  const s = String(raw ?? '').trim()
  if (!s) return null
  return s.slice(0, 4000)
}
