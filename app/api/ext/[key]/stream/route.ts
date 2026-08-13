import {
  getSiteByApiKey,
  normalizePeriod,
  stateForPeriod,
} from '@/lib/god-sites'
import { bare404, CORS_HEADERS, corsPreflight } from '../shared'

export const dynamic = 'force-dynamic'

/**
 * Contract §2 #2 / §4 — SSE live stream. Sends the initial snapshot, then a
 * fresh `state` event whenever the stored revision moves (checked every
 * POLL_DB_MS), plus a comment heartbeat so proxies keep the socket open.
 * The client reconnects itself on drop (EventSource semantics) and falls
 * back to polling GET /state when SSE is unavailable.
 */
const POLL_DB_MS = 2_500
const HEARTBEAT_MS = 25_000

export async function GET(
  req: Request,
  { params }: { params: Promise<{ key: string }> },
) {
  const { key } = await params
  const site = await getSiteByApiKey(key, { touch: true })
  if (!site) return bare404()

  const period = normalizePeriod(
    new URL(req.url).searchParams.get('period') ?? undefined,
  )
  const enc = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let lastRevision = 0
      let closed = false

      const send = (data: unknown) =>
        controller.enqueue(
          enc.encode(`event: state\ndata: ${JSON.stringify(data)}\n\n`),
        )

      const tick = async () => {
        if (closed) return
        try {
          // Re-resolve by key each tick: key rotation or site deletion must
          // terminate the stream (fail-closed), not keep serving stale data.
          const fresh = await getSiteByApiKey(key)
          if (!fresh) {
            close()
            return
          }
          if (fresh.revision !== lastRevision) {
            lastRevision = fresh.revision
            send(stateForPeriod(fresh.state, period, fresh.revision))
          }
        } catch {
          // Transient DB hiccup — keep the stream, next tick retries.
        }
      }

      const iv = setInterval(() => void tick(), POLL_DB_MS)
      const hb = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(`: hb\n\n`))
      }, HEARTBEAT_MS)

      const close = () => {
        if (closed) return
        closed = true
        clearInterval(iv)
        clearInterval(hb)
        try {
          controller.close()
        } catch {
          // Already closed by the runtime.
        }
      }

      req.signal.addEventListener('abort', close)

      // Initial snapshot straight away.
      lastRevision = site.revision
      send(stateForPeriod(site.state, period, site.revision))
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

export function OPTIONS() {
  return corsPreflight()
}
