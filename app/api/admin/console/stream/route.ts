import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import type { AssistantTurn } from '@/lib/admin-console/assistant'
import {
  lastUserText,
  normalizeTurns,
  prepareAssistantRun,
  runAssistantOnce,
} from '@/lib/admin-console/run-assistant'

/**
 * Streaming endpoint for the OMNIDESK OS shell copilot. Same SSE line protocol
 * as /api/admin/ai-console/stream:
 *   { t: 'delta', v: string }   incremental reply text
 *   { t: 'meta',  v: {...} }     structured AssistantResult (minus reply)
 *   { t: 'error' }              generation failed — client should fall back
 *   [DONE]                       stream finished
 */

export const dynamic = 'force-dynamic'

const encoder = new TextEncoder()
const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)

export async function POST(req: Request): Promise<Response> {
  await requireAdmin()

  let history: AssistantTurn[] = []
  try {
    const body = (await req.json()) as { history?: AssistantTurn[] }
    history = Array.isArray(body.history) ? body.history : []
  } catch {
    history = []
  }

  const turns = normalizeTurns(history)
  const text = lastUserText(turns)

  // Offline / no-gateway: return the deterministic one-shot result as a
  // single delta+meta so the client renders it through the same path.
  if (!isBrainConfigured() || !text) {
    const result = await runAssistantOnce(history)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.reply) controller.enqueue(sse({ t: 'delta', v: result.reply }))
        const { reply: _reply, ...meta } = result
        controller.enqueue(sse({ t: 'meta', v: meta }))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: sseHeaders() })
  }

  const run = prepareAssistantRun(turns)

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = ''
      try {
        const result = await run.agent.stream({ messages: run.messages })
        for await (const delta of result.textStream) {
          full += delta
          controller.enqueue(sse({ t: 'delta', v: delta }))
        }
        const finalized = run.finalize(full)
        const { reply: _reply, ...meta } = finalized
        controller.enqueue(sse({ t: 'meta', v: meta }))
      } catch {
        controller.enqueue(sse({ t: 'error' }))
      } finally {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    },
  })

  return new Response(stream, { headers: sseHeaders() })
}

function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  }
}
