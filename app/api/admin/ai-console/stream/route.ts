import { requireAdmin } from '@/lib/auth'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import { streamConsoleTurn } from '@/lib/console-stream'
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
 * unavailable, so the console never dead-ends. SSE protocol lives in
 * lib/console-stream.ts (shared with the servers console).
 */

export const dynamic = 'force-dynamic'

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

  return streamConsoleTurn({
    canStream: isBrainConfigured() && Boolean(text),
    runOnce: () => runAssistantOnce(history),
    prepareRun: () => prepareAssistantRun(turns),
    revalidateOn: (result) => (result.settingsChanged ? AI_PATH : null),
  })
}
