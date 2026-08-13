import {
  commitAutoSpend,
  getSiteBySlugAndKey,
  normalizePeriod,
  stateForPeriod,
  type SitePeriod,
} from '@/lib/god-sites'
import {
  bare401,
  bare404,
  CORS_HEADERS,
  corsPreflight,
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

export async function GET(
  req: Request,
  ctx: { params: Promise<{ page: string }> },
): Promise<Response> {
  const { page } = await ctx.params
  const token = readToken(req)
  if (!token) return bare401()

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
            // Auto-spend makes `today` a function of the clock, so the
            // payload changes every tick even at the same revision — resend
            // continuously while it's on; otherwise only on real edits.
            const autoTicking =
              fresh.state.autoSpend?.enabled === true &&
              (period === 'today' || period === 'yesterday')
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
