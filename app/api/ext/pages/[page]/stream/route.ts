import {
  commitAutoSpend,
  getOrCreateSiteKey,
  getSiteBySlugAndKey,
  normalizePeriod,
  stateForPeriod,
  verifyStreamTicket,
  type GodSite,
  type SitePeriod,
} from '@/lib/god-sites'
import { clientIpFromHeaders } from '@/lib/client-ip'
import { acquireStreamSlot } from '@/lib/sse-gauge'
import {
  bare401,
  bare404,
  bare429,
  CORS_HEADERS,
  corsPreflight,
  extIpGuard,
  readToken,
} from '../shared'
import { subscribeSite } from './poller'

/**
 * GET /api/ext/pages/{PAGE_ID}/stream?period=<p>&ticket=<k> — the OPTIONAL
 * SSE endpoint of the page3.html contract (§4). Emits `event: state` whose
 * data is the full contract `State` (same shape as GET /state): an initial
 * snapshot on connect, then a new one whenever the god panel edits the site
 * (detected by revision change on a cheap DB poll). Heartbeat comments keep
 * proxies from idling the connection out.
 *
 * AUTH (#7): EventSource cannot set headers, so credentials ride in the query
 * string. New clients pass a short-lived, signed `?ticket=` (minted via
 * /stream-ticket with a header-authenticated request) so the long-lived token
 * never lands in access logs. Already-installed extensions still pass the raw
 * `?token=`; both are accepted, ticket first.
 *
 * CONCURRENCY (#4): each open stream holds timers, a socket and a poll
 * subscription. We reserve a per-IP / per-token slot via the shared SSE gauge
 * BEFORE creating the stream (atomic, no TOCTOU) and release it exactly once
 * when the stream ends. The gauge is Redis-backed (shared across instances)
 * when configured, self-healing under crashes, and falls back to a correct
 * per-process gauge otherwise.
 */

export const dynamic = 'force-dynamic'

const HEARTBEAT_MS = 25_000

/**
 * Hard ceiling on a single stream's lifetime. A well-behaved client reconnects
 * transparently (EventSource auto-retries), so forcibly closing after this
 * bounds resource use and guarantees a leaked/wedged connection can't pin a
 * concurrency slot indefinitely even if abort somehow never fires.
 */
const MAX_STREAM_LIFETIME_MS = 30 * 60_000

export async function GET(
  req: Request,
  ctx: { params: Promise<{ page: string }> },
): Promise<Response> {
  const { page } = await ctx.params
  const url = new URL(req.url)
  const ticket = url.searchParams.get('ticket')?.trim() ?? ''
  const token = readToken(req)

  // Credentials must be present as EITHER a ticket or a raw token.
  if (!ticket && !token) return bare401()

  // Cap how often one IP can (re)open a stream (network blips / serverless
  // timeouts stay well under 40/min).
  const connGuard = await extIpGuard(req, 'stream', 40, 60_000)
  if (!connGuard.allowed) return bare429(connGuard.retryAfterSec)

  // Resolve + authenticate. Prefer the ticket (keeps the token out of the URL);
  // fall back to the legacy raw token for older installed extensions.
  let resolved: GodSite | null = null
  let pollKey = token // key the shared poller re-resolves with (raw token path)
  if (ticket) {
    resolved = await verifyStreamTicket(page, ticket)
    if (resolved) {
      // The ticket carries no raw token, but the poller re-resolves by
      // slug+key each tick to detect revocation. Use the site's permanent
      // server-side key (never sent to the client) so revocation semantics are
      // identical to the token path — a rotated key makes the poll return null
      // and the stream closes.
      pollKey = (await getOrCreateSiteKey(resolved.id)) ?? ''
    }
  }
  if (!resolved && token) resolved = await getSiteBySlugAndKey(page, token, { touch: true })
  if (!resolved) return bare404()

  // The concurrency slot is keyed on the site id (stable across ticket/token)
  // so both auth paths share one ceiling per vitrine.
  const ip = clientIpFromHeaders(req.headers)
  const slotKey = `site:${resolved.id}`
  const acq = await acquireStreamSlot(ip, slotKey)
  if (!acq.ok || !acq.slot) return bare429(30)
  const slot = acq.slot

  const site = await commitAutoSpend(resolved)

  const period: SitePeriod = normalizePeriod(
    url.searchParams.get('period') ?? undefined,
  )

  const enc = new TextEncoder()
  let lastRevision = site.revision

  const stream = new ReadableStream({
    start(controller) {
      const send = (payload: unknown) => {
        controller.enqueue(
          enc.encode(`event: state\ndata: ${JSON.stringify(payload)}\n\n`),
        )
      }
      // Initial snapshot so the page renders immediately.
      send(stateForPeriod(site.state, period))

      // Subscribe to the shared per-(slug, key) poller instead of running our
      // own DB loop, so many viewers of one vitrine share a single poll.
      const unsubscribe = subscribeSite(page, pollKey, (fresh) => {
        if (!fresh) {
          // Key rotated/deleted — the shared poll no longer resolves it.
          cleanup()
          try {
            controller.close()
          } catch {
            /* already closed */
          }
          return
        }
        // Auto-spend makes `today` — and the aggregates that include today's
        // partial (week/month/all) — a function of the clock, so the payload
        // changes every tick even at the same revision; resend continuously
        // while it's on. `yesterday` is a finished day (fraction = 1,
        // deterministic): identical every tick, so only real edits (revision
        // bumps) resend it.
        const autoTicking =
          fresh.state.autoSpend?.enabled === true && period !== 'yesterday'
        if (fresh.revision !== lastRevision || autoTicking) {
          lastRevision = fresh.revision
          send(stateForPeriod(fresh.state, period))
        }
      })

      const heartbeat = setInterval(() => {
        controller.enqueue(enc.encode(`: hb\n\n`))
        // Keep the concurrency slot alive while the stream is healthy.
        slot.refresh()
      }, HEARTBEAT_MS)

      // Hard lifetime cap: close cleanly so EventSource reconnects and the slot
      // is released, bounding the resources any single connection can hold.
      const lifetimeCap = setTimeout(() => {
        cleanup()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      }, MAX_STREAM_LIFETIME_MS)

      let released = false
      const cleanup = () => {
        if (released) return
        released = true
        unsubscribe()
        clearInterval(heartbeat)
        clearTimeout(lifetimeCap)
        slot.release()
      }
      req.signal.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      })
    },
    cancel() {
      // Reader went away without an abort event (some runtimes) — release too.
      slot.release()
    },
  })

  return new Response(stream, {
    headers: {
      ...CORS_HEADERS,
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  })
}

export function OPTIONS(): Response {
  return corsPreflight()
}
