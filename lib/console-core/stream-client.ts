'use client'

/**
 * Общий SSE-клиент разговорных консолей (Admin AI, «Серверы»). Оба стрим-роута
 * говорят на одном протоколе — события `data: {"t":"delta"|"meta"|"error"}` —
 * различается только URL и форма meta, поэтому транспорт generic по M.
 * Консоли собирают из {text, meta} свой AssistantResult сами.
 */

export interface ConsoleStreamCallbacks {
  /** Fired with the full accumulated text after every delta. */
  onText: (text: string) => void
  /** True while the request is still the newest one; stale streams stop. */
  isCurrent: () => boolean
}

export interface ConsoleStreamResult<M> {
  text: string
  meta: M | null
}

/**
 * Stream a console reply. Resolves with the accumulated text and the final
 * meta event, or `null` when the request was superseded mid-stream (a newer
 * request owns the UI — the caller must go silent). Throws when the transport
 * fails so the caller can fall back to its one-shot server action.
 */
export async function streamConsoleReply<M>(
  url: string,
  history: unknown,
  signal: AbortSignal,
  cb: ConsoleStreamCallbacks,
): Promise<ConsoleStreamResult<M> | null> {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ history }),
    signal,
  })
  if (!resp.ok || !resp.body) throw new Error('stream failed')

  const reader = resp.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let streamed = ''
  let meta: M | null = null

  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    if (!cb.isCurrent()) {
      await reader.cancel()
      return null
    }
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const payload = trimmed.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const evt = JSON.parse(payload) as
          | { t: 'delta'; v: string }
          | { t: 'meta'; v: M }
          | { t: 'error' }
        if (evt.t === 'delta') {
          streamed += evt.v
          cb.onText(streamed)
        } else if (evt.t === 'meta') {
          meta = evt.v
        } else if (evt.t === 'error') {
          throw new Error('generation error')
        }
      } catch {
        /* ignore malformed line */
      }
    }
  }

  if (!cb.isCurrent()) return null
  return { text: streamed, meta }
}
