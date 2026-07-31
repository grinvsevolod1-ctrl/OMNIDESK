import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import type { AssistantTurn } from '@/lib/ai-console/assistant'
import {
  AI_PATH,
  lastUserText,
  normalizeTurns,
  prepareAssistantRun,
  runAssistantOnce,
} from '@/lib/ai-console/run-assistant'

/**
 * Streaming endpoint for the AI-manager co-pilot. Streams the assistant's reply
 * token-by-token (SSE), then emits a final `meta` event carrying the structured
 * result (receipts, opened panel, pending confirmation, settings-changed flag).
 * Admin-only. Falls back to the one-shot deterministic path when the gateway is
 * unavailable, so the console never dead-ends.
 *
 * SSE line protocol (one JSON object per `data:` line):
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

  // Offline / no-gateway: no streaming possible — return the deterministic
  // one-shot result in a single meta event so the client renders it normally.
  if (!isBrainConfigured() || !text) {
    const result = await runAssistantOnce(history)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.reply) {
          controller.enqueue(sse({ t: 'delta', v: result.reply }))
        }
        const { reply: _reply, ...meta } = result
        controller.enqueue(sse({ t: 'meta', v: meta }))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: sseHeaders() })
  }

  const run = await prepareAssistantRun(turns)

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
        if (finalized.settingsChanged) revalidatePath(AI_PATH)
        // Strip the reply — the client already assembled it from deltas.
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
