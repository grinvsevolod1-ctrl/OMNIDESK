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
  const isAdmin = session.role === 'admin'
  // Куратор подключается к тому же SSE для раздела «Чаты» (миграция 151):
  // его события скоупятся по curator_id, а не manager_id. viewerId — id
  // текущего зрителя в любой роли; isCurator меняет и фильтрацию, и
  // gap-recovery (у куратора нет менеджерского бэкфилла — шлём resync).
  const viewerId = session.sub
  const isCurator = session.role === 'curator'
  // Руководитель (/head) и медиабайер (/buyer) подписаны на этот же SSE только
  // ради lead-пинка: событие несёт лишь сигнал «лиды изменились» (без данных),
  // а их вьюхи перезапрашивают свои списки через собственные server actions с
  // проверкой прав. Поэтому им безопасно доставлять ВСЕ lead-события (как
  // админу) — точечная фильтрация по связям здесь была бы дорогой и лишней.
  const isHead = session.role === 'head'
  const isBuyer = session.role === 'buyer'
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
      // Куратор: менеджерского бэкфилла нет — при реконнекте с Last-Event-ID
      // просто просим клиента перезапросить данные (resync), без id.
      if (lastEventId && isCurator) {
        send('update', { type: 'conversation', managerId: viewerId, event: 'resync' })
      } else if (lastEventId && !isHead && !isBuyer) {
        // head/buyer: менеджерских сообщений нет — бэкфилл не нужен. Клиент
        // (useLeadEvents) сам пинает поллеры на 'ready' после реконнекта.
        const since = new Date(lastEventId)
        if (!Number.isNaN(since.getTime())) {
          try {
            const { messages: missed, truncated } = await getMessagesSince(
              managerId,
              since,
            )
            if (truncated) {
              // The client missed more messages than we replay. Replaying a
              // partial set would leave the inbox silently out of sync, so
              // instead tell it to pull fresh server data in full. No `id` is
              // sent so this doesn't advance Last-Event-ID.
              send('update', {
                type: 'conversation',
                managerId,
                event: 'resync',
              })
            } else {
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
            }
          } catch (err) {
            console.error('[stream] gap-recovery backfill failed:', err)
          }
        }
      }

      // Comment heartbeat keeps proxies/load-balancers from closing the stream.
      heartbeat = setInterval(() => safeEnqueue(`: ping\n\n`), 25_000)

      unsubscribe = subscribeRealtime((event: RealtimeEvent) => {
        // Hub-level resync: the LISTEN connection dropped and reconnected, so
        // NOTIFYs may have been lost for EVERY manager. It carries no
        // managerId (it is not a DB event), so handle it before the scoping
        // filter — reusing the same frame shape as the truncated-replay path,
        // which the client already understands as "re-fetch everything".
        if (event.type === 'resync') {
          send('update', { type: 'conversation', managerId, event: 'resync' })
          return
        }
        // Lead-card events (migration 127) are scoped differently from the
        // rest: a card belongs to a manager AND (optionally) a curator, and
        // admins see every lead. Handle before the manager-only filter below.
        // No `id` — leads are refetched in full, never replayed from a gap.
        if (event.type === 'lead') {
          if (
            isAdmin ||
            isHead ||
            isBuyer ||
            event.managerId === managerId ||
            event.curatorId === managerId
          ) {
            // id (миграция 170) позволяет ОТКРЫТОЙ карточке обновиться точечно,
            // а спискам — как раньше сделать полный refetch, игнорируя id.
            send('lead', { type: 'lead', id: event.id })
          }
          return
        }
        // Source-finance события (миграция 170): расход/депозит/сам источник.
        // Дашборды обзора (админ/руководитель) и модал отчёта видят все
        // источники; байер — только свои (по buyerId). Менеджеру/куратору
        // источники не нужны. Payload несёт лишь id источника для точечного
        // рефетча — данные потребитель тянет своим scoped-экшеном.
        if (event.type === 'source') {
          if (isAdmin || isHead || (isBuyer && event.buyerId === viewerId)) {
            send('source', { type: 'source', id: event.sourceId })
          }
          return
        }
        // Channel-события админского уровня (напр. виджет livechat впервые
        // подключился с сайта, markLivechatConnected). Нужны только админу —
        // это его экран livechat переключает «Не интегрирован» → «Активен».
        if (event.type === 'channel') {
          if (isAdmin) {
            send('channel', { type: 'channel', channelId: event.channelId })
          }
          return
        }
        // Куратор: доставляем ТОЛЬКО message/conversation-события его
        // переданных диалогов (по curator_id). Эфемерные typing/presence и
        // channel-события — менеджерские, куратору не нужны.
        if (isCurator) {
          if (event.type !== 'message' && event.type !== 'conversation') return
          if (event.curatorId !== viewerId) return
          send('update', event, event.createdAt)
          return
        }
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
