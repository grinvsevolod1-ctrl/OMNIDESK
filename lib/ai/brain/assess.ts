/**
 * Conversation assessment: readiness gating and detection, per-client memory
 * extraction, and escalation-to-human detection. Same dependency rules as the
 * rest of lib/ai/brain/ (see core.ts).
 */

import {
  GATEWAY_URL,
  gatewayStatusHint,
  resolveModel,
  type BrainConfig,
  type BrainLog,
  type BrainMessage,
  type GatewayResponse,
} from './core'

/**
 * Cheap, dependency-free pre-filter for the readiness assessment. Returns true
 * only when the CLIENT's recent messages hint they might be agreeing / handing
 * over contacts — the only situation where the (paid) AI readiness check is
 * worth running. Deliberately a bit generous so we never miss a real
 * conversion; assessLeadReady then makes the final confident call.
 *
 * Shared by BOTH runtimes (Next.js live-chat + worker messenger) so readiness
 * gating and cost behaviour are identical everywhere. NOTE: JS's \b word
 * boundary does not work with Cyrillic, so word boundaries are emulated with
 * Unicode lookarounds under the /u flag.
 */
export function clientShowsReadinessSignal(history: BrainMessage[]): boolean {
  const clientLines = history
    .filter((m) => m.role === 'client')
    .slice(-3)
    .map((m) => m.body.toLowerCase())
  if (clientLines.length === 0) return false
  const text = clientLines.join(' \n ')

  // Agreement / commitment phrasing.
  const AGREE =
    /(?<![\p{L}\p{N}])(да|давай|согласен|согласна|готов|готова|хорошо|ок|окей|договорились|подходит|устраивает|начн[её]м|поехали|интересно|где начать|что дальше|куда писать|скинь|скиньте|скину|отправлю|записывайте)(?![\p{L}\p{N}])/iu
  // Sharing / offering to share contact or personal data.
  const CONTACT =
    /(\+?\d[\d\s\-()]{8,}|@[a-z0-9_]{3,}|телефон|номер|вотсап|whatsapp|вайбер|телеграм|телег[еу]|почт[аеу]|карт[аеуы]|паспорт|реквизит|мои данные|мой номер)/i

  return AGREE.test(text) || CONTACT.test(text)
}

/**
 * Decide whether the client is READY — i.e. has agreed to hand over their
 * contact/personal data and start working with us (the moment a lead becomes
 * «Ликвид» and should be handed to a human). Returns true ONLY on a confident
 * yes, so we never promote prematurely. Pure + dependency-free like the rest of
 * this module; safe to call from both the worker and the panel. When the AI is
 * unavailable it conservatively returns false (no promotion, no false alarms).
 */
export async function assessLeadReady(
  history: BrainMessage[],
  log?: BrainLog,
  config?: BrainConfig,
): Promise<boolean> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) return false
  // Need at least a couple of turns to judge readiness.
  const recent = history.slice(-16)
  if (recent.filter((m) => m.role === 'client').length === 0) return false

  const model = resolveModel(config)
  const transcript = recent
    .map((m) => `${m.role === 'client' ? 'Клиент' : 'Менеджер'}: ${m.body}`)
    .join('\n')

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
              'Ты анализируешь переписку менеджера с клиентом. Определи ОДНО: клиент уже ЯВНО ' +
              'согласился предоставить документы или запрошенный перечень данных (готов прислать/' +
              'показать паспорт, реквизиты, справки, фото документов, заполнить анкету, скинуть ' +
              'нужные сведения) — то есть готов передать то, что запрашивает менеджер. ' +
              'Отвечай СТРОГО одним словом: "ДА" — только если клиент прямо согласился предоставить ' +
              'документы/данные (например «да, скину», «хорошо, вышлю», «куда отправить документы»). ' +
              '"НЕТ" — если он лишь проявляет интерес, задаёт вопросы, сомневается, торгуется, ' +
              'обещает подумать, отказывается или это неясно. Простого интереса НЕДОСТАТОЧНО. ' +
              'Не объясняй, только ДА или НЕТ.',
          },
          { role: 'user', content: transcript },
        ],
        temperature: 0,
        // Must be large enough that the model can emit the word plus any
        // whitespace/framing tokens; a value as low as 3 makes some gateway
        // models reject the request with HTTP 400.
        max_tokens: 16,
      }),
    })
    if (!res.ok) {
      log?.({
        level: 'warn',
        event: 'readiness.http_error',
        message: `Оценка готовности лида: HTTP ${res.status}${gatewayStatusHint(res.status)}`,
        meta: { status: res.status },
      })
      return false
    }
    const data = (await res.json()) as GatewayResponse
    const raw = (data.choices?.[0]?.message?.content ?? '').trim().toLowerCase()
    // Robust parse: look at whole words, not a prefix. `startsWith('да')` used
    // to match "давай"/"далеко" and falsely promote; and reasoning/verbose
    // models may wrap the verdict ("Да, готов"). We scan for a standalone
    // да/yes affirmative while making sure it isn't negated (нет/no) first.
    const tokens = raw.replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter(Boolean)
    // Negation must include the standalone particle «не» — otherwise a verbose
    // "не готов" / "не согласен" is read as affirmative («готов») and the lead
    // is falsely promoted. Any negation token vetoes readiness (conservative).
    const negative = tokens.some(
      (t) => t === 'нет' || t === 'не' || t === 'no' || t === 'not',
    )
    const affirmative = tokens.some(
      (t) => t === 'да' || t === 'yes' || t === 'готов' || t === 'готова',
    )
    const ready = affirmative && !negative
    log?.({
      level: 'debug',
      event: 'readiness.assessed',
      message: ready
        ? 'Клиент выглядит готовым передать данные — кандидат в «Ликвид».'
        : 'Клиент пока не готов — продолжаем вести диалог.',
      meta: { ready },
    })
    return ready
  } catch (err) {
    console.warn(
      '[manager-brain] readiness assessment failed:',
      err instanceof Error ? err.message : String(err),
    )
    return false
  }
}

/**
 * Rebuild the durable per-client memory from the transcript. Produces a short,
 * factual summary (name, city, budget, objections, agreements, next step) that
 * the runtime persists to conversation_ai_memory and feeds back via
 * ManagerBrainInput.memory. `prevMemory` is the last summary so the model can
 * merge rather than start over. Returns null on any failure (runtime keeps the
 * previous memory). Dependency-free: model is caller-provided via BrainConfig.
 */
export async function extractClientMemory(
  history: BrainMessage[],
  prevMemory: string,
  log?: BrainLog,
  config?: BrainConfig,
): Promise<string | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) return null
  const recent = history.slice(-24)
  if (recent.length === 0) return null

  const transcript = recent
    .map((m) => `${m.role === 'client' ? 'Клиент' : 'Менеджер'}: ${m.body}`)
    .join('\n')
  const model = resolveModel(config)

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
              'Ты ведёшь короткую фактическую карточку клиента по переписке. Верни компактную ' +
              'сводку (не более 8 строк) ТОЛЬКО и�� фактов, которые клиент реально сообщил: имя, ' +
              'город/регион, возраст, занятость, бюджет/зарплатные ожидания, график, возражения и ' +
              'сомнения, о чём договорились, какой следующий шаг. Пиши по-русски, по одному факту ' +
              'в строке, кратко, без воды и без выдумок. Если фактов нет — верни пустую строку. ' +
              'Обнови и объедини с уже известным, не теряя ранее зафиксированное.',
          },
          {
            role: 'user',
            content:
              (prevMemory.trim()
                ? `Уже известно:\n${prevMemory.trim()}\n\n`
                : '') + `Переписка:\n${transcript}`,
          },
        ],
        temperature: 0.2,
        max_tokens: 300,
      }),
    })
    if (!res.ok) {
      log?.({
        level: 'warn',
        event: 'memory.http_error',
        message: `Обновление памяти клиента: HTTP ${res.status}${gatewayStatusHint(res.status)}`,
        meta: { status: res.status },
      })
      return null
    }
    const data = (await res.json()) as GatewayResponse
    const summary = (data.choices?.[0]?.message?.content ?? '').trim()
    log?.({
      level: 'debug',
      event: 'memory.updated',
      message: summary ? `Память клиента обновлена (${summary.length} симв.)` : 'Память клиента пуста.',
    })
    return summary
  } catch (err) {
    console.warn(
      '[manager-brain] memory extraction failed:',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/** Verdict from the escalation detector. */
export interface EscalationVerdict {
  escalate: boolean
  reason: string
}

const ESCALATION_NONE: EscalationVerdict = { escalate: false, reason: '' }

/**
 * Detect when the bot should hand off to a human: the client is angry/insulting,
 * explicitly demands a real person/operator, threatens to leave/complain, or the
 * conversation is clearly stuck (client repeating the same objection with no
 * progress). Conservative by design — returns escalate=false on any uncertainty
 * or failure so it never hands off a healthy dialog. The runtime acts on a true
 * verdict via markAiHandoffToHuman (pauses AI, moves the lead to «Передан человеку»).
 */
export async function detectEscalation(
  history: BrainMessage[],
  log?: BrainLog,
  config?: BrainConfig,
): Promise<EscalationVerdict> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) return ESCALATION_NONE
  const recent = history.slice(-12)
  // Need at least a couple of client turns to judge a stuck/angry pattern.
  if (recent.filter((m) => m.role === 'client').length < 2) return ESCALATION_NONE

  const transcript = recent
    .map((m) => `${m.role === 'client' ? 'Клиент' : 'Менеджер'}: ${m.body}`)
    .join('\n')
  const model = resolveModel(config)

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
              'Ты решаешь, нужно ли передать диалог живому сотруднику. Ответь СТРОГО в формате ' +
              '"ДА: причина" или "НЕТ". Отвечай ДА только если: клиент откровенно зол, оскорбляет, ' +
              'угрожает жалобой/уходом; либо прямо и настойчиво требует живого человека/оператора/' +
              'руководителя; либо диалог зашёл в тупик (клиент несколько раз повторяет одно и то же ' +
              'возражение без всякого прогресса). Во всех остальных случаях — обычный интерес, ' +
              'вопросы, торг, сомнения, «подумаю» — отвечай НЕТ. Причина — 3-6 слов по-русски.',
          },
          { role: 'user', content: transcript },
        ],
        temperature: 0,
        max_tokens: 24,
      }),
    })
    if (!res.ok) {
      log?.({
        level: 'warn',
        event: 'escalation.http_error',
        message: `Детектор эскалации: HTTP ${res.status}${gatewayStatusHint(res.status)}`,
        meta: { status: res.status },
      })
      return ESCALATION_NONE
    }
    const data = (await res.json()) as GatewayResponse
    const raw = (data.choices?.[0]?.message?.content ?? '').trim()
    const escalate = /^\s*да\b/i.test(raw)
    const reason = escalate ? raw.replace(/^\s*да\s*[:\-—]?\s*/i, '').trim() : ''
    log?.({
      level: escalate ? 'info' : 'debug',
      event: 'escalation.assessed',
      message: escalate
        ? `Нужна передача человеку: ${reason || 'причина не указана'}`
        : 'Эскалация не требуется — продолжаем вести диалог.',
      meta: { escalate, reason },
    })
    return { escalate, reason }
  } catch (err) {
    console.warn(
      '[manager-brain] escalation detection failed:',
      err instanceof Error ? err.message : String(err),
    )
    return ESCALATION_NONE
  }
}
