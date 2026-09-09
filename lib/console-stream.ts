import { revalidatePath } from 'next/cache'

/**
 * Shared SSE machinery for the conversational admin consoles that stream a
 * reply token-by-token and then emit one structured `meta` frame.
 *
 * Currently backs /api/admin/ai-console/stream and
 * /api/admin/servers-console/stream — their control flow was byte-for-byte
 * identical apart from which run-assistant module they import and which
 * data-changed flag triggers revalidation. The richer /api/admin/console
 * stream (status frames, local commands, offline fallback) deliberately does
 * NOT use this helper.
 *
 * SSE line protocol (one JSON object per `data:` line):
 *   { t: 'delta', v: string }   incremental reply text
 *   { t: 'meta',  v: {...} }     structured result (minus reply)
 *   { t: 'error' }              generation failed — client should fall back
 *   [DONE]                       stream finished
 */

const encoder = new TextEncoder()
const sse = (obj: unknown) => encoder.encode(`data: ${JSON.stringify(obj)}\n\n`)

export function sseHeaders(): HeadersInit {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  }
}

/** A finalized assistant result: any struct that carries a `reply`. */
type AssistantResultLike = { reply?: string }

/**
 * The streaming run each console builds. Kept structurally loose on purpose:
 * `Run` is inferred from the caller's own `prepareAssistantRun`, so the AI
 * SDK's concrete agent/message types flow through unchanged and we never
 * re-describe (or narrow) them here.
 */
export interface StreamRun<Result extends AssistantResultLike> {
  agent: { stream: (input: { messages: never }) => Promise<{ textStream: AsyncIterable<string> }> }
  messages: unknown
  finalize: (fullText: string) => Result
}

/** Everything a console route must supply to run one streamed turn. */
export interface ConsoleStreamConfig<
  Result extends AssistantResultLike,
  Run extends StreamRun<Result>,
> {
  /** True when the AI gateway is usable and there is user text to answer. */
  canStream: boolean
  /** Deterministic one-shot result for the offline / no-gateway path. */
  runOnce: () => Promise<Result>
  /** Build the streaming run (agent + messages + finalizer). */
  prepareRun: () => Promise<Run> | Run
  /**
   * Revalidate the console page when the finalized result changed data.
   * Return the path to revalidate, or null to skip.
   */
  revalidateOn: (result: Result) => string | null
}

/** Strip `reply` — the client already assembled it from delta frames. */
function toMeta<Result extends AssistantResultLike>(result: Result) {
  const { reply: _reply, ...meta } = result
  return meta as Omit<Result, 'reply'>
}

/**
 * Build the SSE Response for one console turn. Handles both the offline
 * one-shot path and the live streaming path, matching the previous per-route
 * behaviour exactly.
 */
export async function streamConsoleTurn<
  Result extends AssistantResultLike,
  Run extends StreamRun<Result>,
>(config: ConsoleStreamConfig<Result, Run>): Promise<Response> {
  // Offline / no-gateway: no streaming possible — return the deterministic
  // one-shot result in a single meta event so the client renders it normally.
  if (!config.canStream) {
    const result = await config.runOnce()
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        if (result.reply) controller.enqueue(sse({ t: 'delta', v: result.reply }))
        controller.enqueue(sse({ t: 'meta', v: toMeta(result) }))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    return new Response(stream, { headers: sseHeaders() })
  }

  const run = await config.prepareRun()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = ''
      try {
        const result = await run.agent.stream({
          messages: run.messages as never,
        })
        for await (const delta of result.textStream) {
          full += delta
          controller.enqueue(sse({ t: 'delta', v: delta }))
        }
        const finalized = run.finalize(full)
        const path = config.revalidateOn(finalized)
        if (path) revalidatePath(path)
        controller.enqueue(sse({ t: 'meta', v: toMeta(finalized) }))
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
