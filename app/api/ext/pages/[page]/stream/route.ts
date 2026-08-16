import {
  commitAutoSpend,
  getSiteBySlugAndKey,
  normalizePeriod,
  stateForPeriod,
  type SitePeriod,
} from '@/lib/god-sites'
import { clientIpFromHeaders } from '@/lib/client-ip'
import {
  bare401,
  bare404,
  bare429,
  CORS_HEADERS,
  corsPreflight,
  extIpGuard,
  readToken,
} from '../shared'

/**
 * GET /api/ext/pages/{PAGE_ID}/stream?period=<p>&token=<t> — the OPTIONAL
 * SSE endpoint of the page3.html contract (§4). Emits `event: state` whose
 * data is the full contract `State` (same shape as GET /state): an initial
 * snapshot on connect, then a new one whenever the god panel edits the site
 * (detected by revision change on a cheap DB poll). Heartbeat comments keep
 * proxies from idling the connection out.
 *
 * The token rides in ?token= — EventSource cannot set headers (§4).
 */

export const dynamic = 'force-dynamic'

const DB_POLL_MS = 3_000
const HEARTBEAT_MS = 25_000

/**
 * Concurrent-connection caps for the SSE endpoint. Each open stream holds two
 * live timers and polls the DB every DB_POLL_MS, so a client that opens many
 * streams — or many clients behind one NAT — could pin server resources even
 * while staying under the per-minute (re)connect rate limit. We track live
 * streams in-process and refuse new ones past these ceilings. (In-process is
 * the right scope: the resource being protected — timers and open sockets —
 * lives in this process too.)
 */
const MAX_STREAMS_PER_IP = 20
const MAX_STREAMS_PER_TOKEN = 40
const ipStreams = new Map<string, number>()
const tokenStreams = new Map<string, number>()

function bump(map: Map<string, number>, key: string, delta: number): number {
  const next = (map.get(key) ?? 0) + delta
  if (next <= 0) map.delete(key)
  else map.set(key, next)
  return next
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ page: string }> },
): Promise<Response> {
  const { page } = await ctx.params
  const token = readToken(req)
  if (!token) return bare401()

  // Cap how often one IP can (re)open a stream (network blips / serverless
  // timeouts stay well under 40/min), then refuse if this IP or token already
  // holds too many concurrent streams.
  const connGuard = await extIpGuard(req, 'stream', 40, 60_000)
  if (!connGuard.allowed) return bare429(connGuard.retryAfterSec)

  const ip = clientIpFromHeaders(req.headers)
  if ((ipStreams.get(ip) ?? 0) >= MAX_STREAMS_PER_IP) return bare429(30)
  if ((tokenStreams.get(token) ?? 0) >= MAX_STREAMS_PER_TOKEN) return bare429(30)

  const resolved = await getSiteBySlugAndKey(page, token, { touch: true })
  if (!resolved) return bare404()
  const site = await commitAutoSpend(resolved)

  const period: SitePeriod = normalizePeriod(
    new URL(req.url).searchParams.get('period') ?? undefined,
  )

  const enc = new TextEncoder()
  let lastRevision = site.revision

  const stream = new ReadableStream({
    start(controller) {
      // Count this live stream against both caps; `cleanup` releases exactly
      // once (guarded by `released`) whether the client aborts, the key is
      // revoked, or a controller error fires.
      bump(ipStreams, ip, +1)
      bump(tokenStreams, token, +1)
      let released = false

      const send = (payload: unknown) => {
        controller.enqueue(
          enc.encode(`event: state\ndata: ${JSON.stringify(payload)}\n\n`),
        )
      }
      // Initial snapshot so the page renders immediately.
      send(stateForPeriod(site.state, period))

      const poll = setInterval(() => {
        // Re-resolving by slug+key each tick doubles as live revocation:
        // a rotated/deleted key kills the stream on the next poll.
        void getSiteBySlugAndKey(page, token, { touch: true })
          .then((found) => (found ? commitAutoSpend(found) : null))
          .then((fresh) => {
            if (!fresh) {
              cleanup()
              controller.close()
              return
            }
            // Auto-spend makes `today` — and the aggregates that include
            // today's partial (week/month/all) — a function of the clock, so
            // the payload changes every tick even at the same revision;
            // resend continuously while it's on. `yesterday` is a finished
            // day (fraction = 1, deterministic): identical every tick, so
            // only real edits (revision bumps) resend it.
            const autoTicking =
              fresh.state.autoSpend?.enabled === true && period !== 'yesterday'
            if (fresh.revision !== lastRevision || autoTicking) {
              lastRevision = fresh.revision
              send(stateForPeriod(fresh.state, period))
            }
          })
          .catch(() => {
            /* transient DB error — keep the stream, retry next tick */
          })
      }, DB_POLL_MS)

      const heartbeat = setInterval(() => {
        controller.enqueue(enc.encode(`: hb\n\n`))
      }, HEARTBEAT_MS)

      const cleanup = () => {
        clearInterval(poll)
        clearInterval(heartbeat)
        if (!released) {
          released = true
          bump(ipStreams, ip, -1)
          bump(tokenStreams, token, -1)
        }
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
