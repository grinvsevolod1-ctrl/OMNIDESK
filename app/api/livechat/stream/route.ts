import {
  getLivechatChannelByApiKey,
  listVisitorMessages,
  markLivechatConnected,
} from '@/lib/data'
import {
  clientIp,
  corsHeaders,
  originAllowed,
  preflight,
  tooMany,
  visitorHandle,
} from '@/lib/livechat'
import { rateLimit } from '@/lib/rate-limit'
import { type RealtimeEvent, subscribeRealtime } from '@/lib/realtime'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Outbound SSE stream for a website live-chat widget.
 *
 * The widget opens an EventSource to /api/livechat/stream?key=...&visitor=...
 * (EventSource can't send headers, so auth travels in the query string). On
 * connect we replay the visitor's thread once ('history'), then push every new
 * agent reply ('message', direction 'out') in realtime via the shared
 * LISTEN/NOTIFY hub. Events are filtered to this channel + visitor handle so a
 * visitor only ever sees their own conversation.
 */
export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const origin = request.headers.get('origin')
  const cors = corsHeaders(origin)

  // Cap how often one IP can (re)open a long-lived SSE connection, so a script
  // can't exhaust server connection slots. Normal reconnects (network blips,
  // serverless timeouts) stay well under this.
  const connGuard = rateLimit(`lc:stream:ip:${clientIp(request.headers)}`, 40, 60_000)
  if (!connGuard.allowed) return tooMany(cors, connGuard.retryAfterSec)

  const apiKey = (url.searchParams.get('key') ?? '').trim()
  const channel = apiKey ? await getLivechatChannelByApiKey(apiKey) : null
  if (!channel) {
    return new Response('Unauthorized', { status: 401, headers: cors })
  }
  if (!originAllowed(origin, channel)) {
    return new Response('Forbidden', { status: 403, headers: cors })
  }

  // Channel turned off in the admin: tell the widget to hide itself (it listens
  // for the `disabled` SSE event) and close immediately instead of serving a
  // live, working chat on a deactivated integration.
  if (channel.status === 'disconnected') {
    const body =
      `event: disabled\ndata: ${JSON.stringify({ reason: 'disconnected' })}\n\n`
    return new Response(body, {
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        ...cors,
      },
    })
  }

  const handle = visitorHandle(url.searchParams.get('visitor'))

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let closed = false

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
      const send = (event: string, data: unknown) => {
        safeEnqueue(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
      }

      // The widget reached us from an allowed origin with a valid key: the
      // integration is live. Flip the channel's status pending -> connected
      // (idempotent) so the admin reflects the real integration state. The chat
      // stays available regardless of how many managers are assigned — agent
      // availability is handled per-message by the ingest endpoint.
      void markLivechatConnected(channel.id)

      send('ready', { ok: true, active: true })

      // Replay the existing thread so the widget restores context on reconnect.
      try {
        const history = await listVisitorMessages(channel.id, handle)
        send(
          'history',
          history.map((m) => ({
            id: m.id,
            direction: m.direction,
            body: m.body,
            author: m.author,
            createdAt: m.createdAt,
          })),
        )
      } catch (err) {
        console.error('[livechat] history load failed:', err)
      }

      // Heartbeat as a *named* SSE event (not a bare comment) so the widget can
      // track liveness and detect a zombie connection (proxy dropped it without
      // a FIN). The comment line keeps intermediaries from buffering too.
      heartbeat = setInterval(() => {
        safeEnqueue(`: keep-alive\n\n`)
        send('ping', { t: Date.now() })
      }, 20_000)

      unsubscribe = subscribeRealtime((event: RealtimeEvent) => {
        // Ephemeral "agent is typing" ping → relay to the widget as its own
        // event. Scoped to this channel + visitor so guests only see typing in
        // their own conversation.
        if (event.type === 'typing') {
          if (event.actor !== 'agent') return
          if (event.channelId !== channel.id) return
          if (event.contactHandle !== handle) return
          send('typing', { typing: event.typing !== false, author: event.authorName })
          return
        }
        if (event.type !== 'message') return
        if (event.channelId !== channel.id) return
        if (event.contactHandle !== handle) return
        // The widget only needs agent replies; it already rendered its own.
        if (event.direction !== 'out') return
        send('message', {
          id: event.id,
          direction: 'out',
          body: event.body,
          author: event.author,
          createdAt: event.createdAt,
        })
      })

      request.signal.addEventListener('abort', () => cleanup())
    },
    cancel() {
      cleanup()
    },
  })

  function cleanup() {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (unsubscribe) unsubscribe()
  }

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      ...cors,
    },
  })
}

export function OPTIONS(request: Request): Response {
  return preflight(request.headers.get('origin'))
}
