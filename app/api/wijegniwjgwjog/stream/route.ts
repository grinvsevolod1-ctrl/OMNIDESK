import { requireAdmin } from '@/lib/auth'
import { type RealtimeEvent, subscribeRealtime } from '@/lib/realtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Admin-wide Server-Sent Events stream for the God-mode console.
 *
 * Unlike /api/stream (which filters realtime events down to the signed-in
 * manager), this relays EVERY conversation/message/channel event across all
 * managers, so the god console can show live activity for the whole system and
 * reflect a manager's replies to impersonated-client messages the instant they
 * are sent. Guarded by requireAdmin — a non-admin never reaches the stream.
 *
 * Ephemeral typing/presence pings are dropped here; the console only cares
 * about persisted message/conversation/channel changes.
 */
export async function GET(request: Request): Promise<Response> {
  await requireAdmin()

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
    start(controller) {
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

      heartbeat = setInterval(() => safeEnqueue(`: ping\n\n`), 25_000)

      unsubscribe = subscribeRealtime((event: RealtimeEvent) => {
        // The console only reacts to persisted changes, not typing/presence.
        if (event.type === 'typing' || event.type === 'presence') return
        send('update', event, event.createdAt)
      })

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
