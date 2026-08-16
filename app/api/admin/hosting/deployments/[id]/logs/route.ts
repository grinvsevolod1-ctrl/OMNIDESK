import { getSession } from '@/lib/auth'
import { getDeploymentById, listDeployLogs } from '@/lib/data'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Server-Sent Events stream of a deployment's build/run logs for the admin
 * hosting UI.
 *
 * Flow: the worker appends rows to hosting_deploy_logs as it clones/builds/runs
 * the app over SSH -> this route polls for new rows by their per-deployment
 * `seq` and relays each as an SSE frame -> the browser renders them live.
 *
 * Reliability:
 * - Each frame's `id` is the log line's `seq`. On reconnect the browser sends
 *   `Last-Event-ID`; we resume strictly after that seq so no line is duplicated
 *   or lost across a disconnect.
 * - A comment heartbeat keeps proxies from idling the stream.
 * - The stream ends once the deployment reaches a terminal status (success /
 *   failed) and all remaining lines have been flushed.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })
  if (session.role !== 'admin') return new Response('Forbidden', { status: 403 })

  const { id: deploymentId } = await params
  const deployment = await getDeploymentById(deploymentId)
  if (!deployment) return new Response('Not found', { status: 404 })

  const lastEventId = request.headers.get('last-event-id')
  const startSeq = lastEventId ? Number(lastEventId) : 0

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let poll: ReturnType<typeof setInterval> | null = null
  let closed = false

  function cleanup() {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    if (poll) clearInterval(poll)
  }

  const TERMINAL = new Set(['success', 'failed'])

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
      const send = (event: string, data: unknown, id?: number) => {
        let frame = `event: ${event}\n`
        if (id !== undefined) frame += `id: ${id}\n`
        frame += `data: ${JSON.stringify(data)}\n\n`
        safeEnqueue(frame)
      }

      // Cursor: the last seq we have delivered. Resume after Last-Event-ID.
      let cursor = Number.isFinite(startSeq) && startSeq > 0 ? startSeq : 0

      send('ready', { deploymentId, status: deployment.status })

      const flush = async (): Promise<void> => {
        if (closed) return
        try {
          const lines = await listDeployLogs(deploymentId, cursor)
          for (const l of lines) {
            send('log', { seq: l.seq, stream: l.stream, line: l.line }, l.seq)
            cursor = l.seq
          }
          // Re-read status so we know when to end the stream.
          const current = await getDeploymentById(deploymentId)
          if (current) {
            send('status', { status: current.status })
            if (TERMINAL.has(current.status)) {
              // One final drain in case lines landed after the status flip.
              const tail = await listDeployLogs(deploymentId, cursor)
              for (const l of tail) {
                send('log', { seq: l.seq, stream: l.stream, line: l.line }, l.seq)
                cursor = l.seq
              }
              send('done', { status: current.status })
              cleanup()
              try {
                controller.close()
              } catch {
                /* already closed */
              }
            }
          }
        } catch (err) {
          console.error('[hosting-logs] poll failed:', err)
        }
      }

      // Prime immediately, then poll ~1s for new lines.
      await flush()
      poll = setInterval(() => void flush(), 1000)
      heartbeat = setInterval(() => safeEnqueue(`: ping\n\n`), 25_000)

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
