'use client'

/**
 * Стрим-обвязка консоли Admin AI поверх общего SSE-клиента
 * (lib/console-core/stream-client.ts): дергает свой роут и собирает
 * итоговый AssistantResult из текста и meta-события.
 */

import type {
  AssistantResult,
  AssistantTurn,
} from '@/lib/ai-console/assistant'
import {
  streamConsoleReply,
  type ConsoleStreamCallbacks,
} from '@/lib/console-core/stream-client'

export type StreamCallbacks = ConsoleStreamCallbacks

/**
 * Stream the assistant reply. Resolves with the final AssistantResult, or
 * `null` when the request was superseded mid-stream (the caller must then do
 * nothing — a newer request owns the UI). Throws when the transport fails so
 * the caller can fall back to the one-shot server action.
 */
export async function streamAssistantReply(
  history: AssistantTurn[],
  signal: AbortSignal,
  cb: StreamCallbacks,
): Promise<AssistantResult | null> {
  const res = await streamConsoleReply<Omit<AssistantResult, 'reply'>>(
    '/api/admin/ai-console/stream',
    history,
    signal,
    cb,
  )
  if (res === null) return null
  const { text, meta } = res
  return {
    reply: text.trim() || 'Готово.',
    actions: meta?.actions ?? [],
    openPanel: meta?.openPanel ?? null,
    settingsChanged: meta?.settingsChanged ?? false,
    pending: meta?.pending ?? null,
    report: meta?.report ?? null,
    source: meta?.source ?? 'ai',
  }
}
