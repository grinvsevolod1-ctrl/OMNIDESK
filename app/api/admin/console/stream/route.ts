import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import type { AssistantTurn } from '@/lib/admin-console/assistant'
import {
  lastUserText,
  normalizeTurns,
  offlineResult,
  prepareAssistantRun,
  runAssistantOnce,
} from '@/lib/admin-console/run-assistant'
import { tryLocalCommand } from '@/lib/admin-console/local-commands'

/**
 * Streaming endpoint for the OMNIDESK OS shell copilot. Same SSE line protocol
 * as /api/admin/ai-console/stream:
 *   { t: 'delta',  v: string }   incremental reply text
 *   { t: 'status', v: string }   tool progress line («Ищу диалоги…»)
 *   { t: 'meta',   v: {...} }    structured AssistantResult (minus reply)
 *   { t: 'error' }               generation failed — client should fall back
 *   [DONE]                       stream finished
 */

export const dynamic = 'force-dynamic'

const encoder = new TextEncoder()
const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)

export async function POST(req: Request): Promise<Response> {
  const user = await requireAdmin()

  let history: AssistantTurn[] = []
  try {
    const body = (await req.json()) as { history?: AssistantTurn[] }
    history = Array.isArray(body.history) ? body.history : []
  } catch {
    history = []
  }

  const turns = normalizeTurns(history)
  const text = lastUserText(turns)

  // Local command layer FIRST: common reads, navigation, and the clickable
  // table drill-downs are exact phrases — answering them straight from the DB
  // skips the AI gateway entirely (zero tokens, one round-trip). Also the
  // offline / no-gateway path: runAssistantOnce embeds the same layer.
  const local = text ? await tryLocalCommand(text) : null
  if (local || !isBrainConfigured() || !text) {
    const result = local ?? (await runAssistantOnce(history, user.sub))
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.reply) controller.enqueue(sse({ t: 'delta', v: result.reply }))
        controller.enqueue(sse({ t: 'meta', v: result }))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: sseHeaders() })
  }

  // Tool-status frames need the stream controller, which doesn't exist yet
  // when the agent is built — bridge through a mutable sink.
  let statusSink: ((label: string) => void) | null = null
  const run = prepareAssistantRun(turns, user.sub, (label) =>
    statusSink?.(label),
  )

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = ''
      statusSink = (label) => {
        try {
          controller.enqueue(sse({ t: 'status', v: label }))
        } catch {
          // Stream already closed — drop the status silently.
        }
      }
      try {
        const result = await run.agent.stream({ messages: run.messages })
        for await (const delta of result.textStream) {
          full += delta
          controller.enqueue(sse({ t: 'delta', v: delta }))
        }
        let finalized = run.finalize(full)
        // The AI SDK can swallow generation errors inside textStream and end
        // "cleanly" with zero output. An empty run (no text, no tool activity)
        // means the model never actually answered — serve the deterministic
        // fallback instead of a blank bubble.
        if (
          !full.trim() &&
          finalized.actions.length === 0 &&
          finalized.views.length === 0 &&
          !finalized.pending &&
          !finalized.report
        ) {
          // offlineResult tries the local data layer first, then keyword
          // navigation — a dead gateway still gets real answers.
          finalized = await offlineResult(text)
          if (finalized.reply)
            controller.enqueue(sse({ t: 'delta', v: finalized.reply }))
        }
        // Keep reply inside meta too: the client uses it whenever it received
        // no delta frames (proxies that buffer SSE, fallback result, etc).
        controller.enqueue(sse({ t: 'meta', v: finalized }))
      } catch {
        // Generation blew up mid-stream. If nothing was emitted yet, degrade
        // to the offline layer (real data or navigation) instead of an error.
        if (!full.trim()) {
          try {
            const offline = await offlineResult(text)
            if (offline.reply)
              controller.enqueue(sse({ t: 'delta', v: offline.reply }))
            controller.enqueue(sse({ t: 'meta', v: offline }))
          } catch {
            controller.enqueue(sse({ t: 'error' }))
          }
        } else {
          controller.enqueue(sse({ t: 'error' }))
        }
      } finally {
        statusSink = null
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
