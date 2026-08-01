/**
 * Reply generation: the customer-facing hot path. One in-character manager
 * reply per call, with optional self-critique. Same dependency rules as the
 * rest of lib/ai/brain/ (see core.ts).
 */

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_TEMPERATURE,
  GATEWAY_URL,
  gatewayStatusHint,
  humanizeReply,
  looksLikeRefusal,
  resolveModel,
  type BrainConfig,
  type BrainLog,
  type BrainMetric,
  type GatewayResponse,
  type ManagerBrainInput,
} from './core'
import { buildSystemPrompt } from './prompt'

/**
 * One self-critique pass: ask the model to fix the draft only if it breaks the
 * scenario, contradicts known facts, leaks an AI tell, or breaks tone —
 * otherwise return it unchanged. Best-effort: returns the original draft on any
 * failure so it can never make a reply worse or block sending.
 */
async function refineReply(
  draft: string,
  systemPrompt: string,
  key: string,
  model: string,
  log?: BrainLog,
): Promise<string> {
  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'system',
            content:
              'Ты редактор-контролёр. Ниже — инструкция менеджера и черновик его ответа клиенту. ' +
              'Проверь черновик на: (1) противоречие сценарию/правилам, (2) противоречие уже ' +
              'известным фактам о клиенте, (3) признаки ИИ (длинное тире, списки, markdown, штампы ' +
              '«Конечно!», «Рад помочь»), (4) нарушение тона или излишнюю длину. Если всё хорошо — ' +
              'верни черновик БЕЗ ИЗМЕНЕНИЙ. Если есть проблема — верни исправленный вариант одним ' +
              'сообщением, живым разговорным русским. Ничего не поясняй, верни только текст ответа.',
          },
          {
            role: 'user',
            content: `ИНСТРУКЦИЯ МЕНЕДЖЕРА:\n${systemPrompt}\n\nЧЕРНОВИК ОТВЕТА:\n${draft}`,
          },
        ],
        temperature: 0.3,
        max_tokens: 400,
      }),
    })
    if (!res.ok) return draft
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    const refined = humanizeReply(raw.trim().replace(/^["'«»]+|["'«»]+$/g, ''))
    if (!refined || looksLikeRefusal(refined)) return draft
    if (refined !== draft) {
      log?.({
        level: 'debug',
        event: 'reply.refined',
        message: 'Само-критика скорректировала ответ.',
      })
    }
    return refined
  } catch {
    return draft
  }
}

/**
 * Generate ONE in-character manager reply for the current conversation.
 * Returns the trimmed reply, or null when the AI is unavailable / declined /
 * produced nothing usable (callers should then stay silent, never post junk).
 */
export async function generateManagerReply(
  input: ManagerBrainInput,
  log?: BrainLog,
  config?: BrainConfig,
): Promise<string | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) {
    log?.({
      level: 'error',
      event: 'gateway.no_key',
      message: 'Нет ключа AI_GATEWAY_API_KEY — ответ не сгенерирован.',
    })
    return null
  }

  const model = resolveModel(config)
  const temperature =
    typeof config?.temperature === 'number'
      ? config.temperature
      : DEFAULT_TEMPERATURE
  const maxTokens =
    typeof config?.maxTokens === 'number' ? config.maxTokens : DEFAULT_MAX_TOKENS
  const startedAt = Date.now()
  // Emit one structured metric per call (durable A/B analytics live downstream
  // in whatever the runtime's BrainLog writer does with a 'gateway.metrics'
  // event). Kept internal so every return path reports exactly once.
  const emitMetric = (
    outcome: BrainMetric['outcome'],
    usage?: GatewayResponse['usage'],
  ) => {
    const metric: BrainMetric = {
      purpose: 'reply',
      model,
      outcome,
      latencyMs: Date.now() - startedAt,
      promptTokens: usage?.prompt_tokens,
      completionTokens: usage?.completion_tokens,
    }
    log?.({
      level: 'debug',
      event: 'gateway.metrics',
      message: `metric ${outcome} ${metric.latencyMs}ms ${model}`,
      meta: metric as unknown as Record<string, unknown>,
    })
  }

  // Only recent turns — keeps it cheap and focused.
  const recent = input.history.slice(-16)
  const systemPrompt = buildSystemPrompt(input)
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: systemPrompt },
  ]
  for (const m of recent) {
    messages.push({
      role: m.role === 'client' ? 'user' : 'assistant',
      content: m.body,
    })
  }
  // If the client hasn't been quoted yet (fresh AI takeover on an empty-ish
  // thread) give the model an explicit nudge to open.
  if (recent.length === 0) {
    messages.push({
      role: 'user',
      content: '(клиент только что написал в чат, начни диалог)',
    })
  }

  log?.({
    level: 'debug',
    event: 'gateway.request',
    message: `Генерирую ответ (${model}), реплик в контексте: ${recent.length}.`,
    meta: { model, turns: recent.length },
  })

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    })
    if (!res.ok) {
      console.warn('[manager-brain] gateway HTTP', res.status)
      log?.({
        level: 'error',
        event: 'gateway.http_error',
        message: `AI Gateway вернул HTTP ${res.status}${gatewayStatusHint(res.status)}`,
        meta: { status: res.status },
      })
      emitMetric('http_error')
      return null
    }
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    // Strip wrapping quotes the model sometimes adds, then scrub AI tells
    // (em-dashes, markdown) so the client can never spot the bot.
    const clean = humanizeReply(raw.trim().replace(/^["'«»]+|["'«»]+$/g, ''))
    if (!clean) {
      log?.({
        level: 'warn',
        event: 'reply.empty',
        message: 'Модель вернула пустой ответ — ничего не отправлено.',
      })
      emitMetric('empty', data.usage)
      return null
    }
    if (looksLikeRefusal(clean)) {
      log?.({
        level: 'warn',
        event: 'reply.refused',
        message: `Ответ отброшен (похож на отказ/«я ИИ»): "${clean.slice(0, 160)}"`,
      })
      emitMetric('refused', data.usage)
      return null
    }
    // Optional self-critique pass: silently repairs a draft that breaks the
    // scenario/facts/tone or leaks an AI tell. Never worsens or blocks it.
    let finalReply = clean
    if (config?.selfCritique) {
      finalReply = await refineReply(clean, systemPrompt, key, model, log)
    }
    log?.({
      level: 'info',
      event: 'reply.generated',
      message: finalReply,
    })
    emitMetric('ok', data.usage)
    return finalReply
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[manager-brain] generation failed:', msg)
    log?.({
      level: 'error',
      event: 'gateway.exception',
      message: `Сбой запроса к AI Gateway: ${msg}`,
    })
    emitMetric('exception')
    return null
  }
}
