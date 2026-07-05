import { getSession } from '@/lib/auth'
import { getMessagesSince } from '@/lib/data'
import { type RealtimeEvent, subscribeRealtime } from '@/lib/realtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Server-Sent Events stream for the manager inbox.
 *
 * Flow: worker / live-chat ingest write to Postgres -> triggers fire
 * pg_notify('realtime', json) -> the shared LISTEN connection (lib/realtime)
 * fans events out to every connected browser -> this route filters them to the
 * signed-in manager and relays SSE frames.
 *
 * Reliability:
 * - Each message frame carries an `id` (the message createdAt). On reconnect
 *   the browser sends `Last-Event-ID`; we replay everything newer than that
 *   from Postgres so no inbound message is lost across a disconnect.
 * - A comment heartbeat keeps proxies/load-balancers from idling the stream.
 * - The shared hub handles Postgres-side reconnection with backoff.
 */
export async function GET(request: Request): Promise<Response> {
  const session = await getSession()
  if (!session) {
    return new Response('Unauthorized', { status: 401 })
  }
  const managerId = session.sub
  const lastEventId = request.headers.get('last-event-id')

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let closed = false

  function cleanup() {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (unsubscribe) unsubscribe()
  }

  const stream = new ReadableStream({
    async start(controller) {
      const safeEnqueue = (chunk: string) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(chunk))
        } catch {
          /* stream already closed */
        }
      }

      const send = (event: string, data: unknown, id?: string) => {
        let frame = `event: ${event}\n`
        if (id) frame += `id: ${id}\n`
        frame += `data: ${JSON.stringify(data)}\n\n`
        safeEnqueue(frame)
      }

      send('ready', { ok: true, at: new Date().toISOString() })

      // Gap recovery: replay messages missed while the client was disconnected.
      if (lastEventId) {
        const since = new Date(lastEventId)
        if (!Number.isNaN(since.getTime())) {
          try {
            const missed = await getMessagesSince(managerId, since)
            for (const m of missed) {
              send(
                'update',
                {
                  type: 'message',
                  managerId,
                  conversationId: m.conversationId,
                  channelId: m.channelId,
                  contactHandle: m.contactHandle,
                  id: m.id,
                  direction: m.direction,
                  body: m.body,
                  author: m.author,
                  createdAt: m.createdAt,
                  status: m.status,
                  replay: true,
                },
                m.createdAt,
              )
            }
          } catch (err) {
            console.error('[stream] gap-recovery backfill failed:', err)
          }
        }
      }

      // Comment heartbeat keeps proxies/load-balancers from closing the stream.
      heartbeat = setInterval(() => safeEnqueue(`: ping\n\n`), 25_000)

      unsubscribe = subscribeRealtime((event: RealtimeEvent) => {
        // Only deliver events scoped to this manager.
        if (!event.managerId || event.managerId !== managerId) return
        // Ephemeral typing pings from the visitor: relayed on their own SSE
        // event (no id, never replayed) so the inbox can show the live preview.
        if (event.type === 'typing') {
          if (event.actor !== 'visitor') return
          send('typing', event)
          return
        }
        // Ephemeral visitor presence (open/minimized/away/left + heartbeat):
        // relayed on its own SSE event, never replayed, so the inbox can show
        // live "on the site / left" status without persisting anything.
        if (event.type === 'presence') {
          if (event.actor !== 'visitor') return
          send('presence', event)
          return
        }
        send('update', event, event.createdAt)
      })

      // Clean up if the client disconnects (tab closed, navigation).
      request.signal.addEventListener('abort', cleanup)
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
