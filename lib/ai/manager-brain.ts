/**
 * Manager AI "brain" — the shared, PURE reply generator used by BOTH runtimes:
 *   - the Next.js panel (admin trainer + live-chat auto-lead)
 *   - the standalone worker (Telegram/WhatsApp auto-lead)
 *
 * Like lib/autopilot/match.ts this module MUST stay dependency-free: no
 * `server-only`, no database, no React, no `@/` path aliases, NO relative
 * imports, and NOT the `ai` SDK (the worker doesn't install it). It talks to the
 * Vercel AI Gateway directly over its OpenAI-compatible REST endpoint via
 * `fetch`, so it runs identically under Next.js and under tsx in the worker.
 *
 * The knowledge base is shared across all managers (product decision): a single
 * business persona, a distilled playbook, and a corpus of correction "lessons".
 */

/**
 * Optional diagnostics sink. The brain stays dependency-free (no DB, no `@/`),
 * so instead of writing logs itself it emits structured events through this
 * plain callback. Each runtime injects its own writer: the panel persists to
 * the `ai_logs` table, the worker does the same via its repo. Passing nothing
 * keeps the brain silent (its original behaviour).
 */
export type BrainLog = (e: {
  level: 'debug' | 'info' | 'warn' | 'error'
  event: string
  message: string
  meta?: Record<string, unknown>
}) => void

/** A single chat turn as the model sees it. */
export interface BrainMessage {
  role: 'client' | 'manager'
  body: string
}

/** One admin correction used to steer future replies (lightweight RAG). */
export interface BrainLesson {
  situation: string
  corrected: string
  note?: string
}

/** Everything the generator needs to produce one in-character manager reply. */
export interface ManagerBrainInput {
  /** Business context written by the admin (what we do, how we talk). */
  persona: string
  /** Tone/register hint, e.g. "professional", "friendly". */
  tone: string
  /** Distilled bullet-point rules the admin has trained. */
  playbook: string[]
  /** Recent correction lessons (most relevant first). */
  lessons: BrainLesson[]
  /** Conversation so far, oldest → newest. */
  history: BrainMessage[]
}

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions'

// gpt-4.1 gives the most coherent, context-aware replies to real clients — the
// priority for customer-facing messages. Override with MANAGER_AI_MODEL.
const MODEL = process.env.MANAGER_AI_MODEL || 'openai/gpt-4.1'

/** Reply generation is only possible when the gateway key is present. */
export function isBrainConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY)
}

const TONE_HINT: Record<string, string> = {
  professional:
    'Деловой, вежливый, уверенный тон. Без панибратства, но по-человечески.',
  friendly: 'Дружелюбный, тёплый тон. Можно проще, но грамотно.',
  concise: 'Максимально коротко и по делу, без воды.',
  persuasive:
    'Убедительный, мотивирующий тон. Мягко ведёшь клиента к следующему шагу.',
}

function toneLine(tone: string): string {
  return TONE_HINT[tone] || TONE_HINT.professional
}

function buildSystemPrompt(input: ManagerBrainInput): string {
  const parts: string[] = [
    'Ты — менеджер компании, который лично ведёт переписку с клиентом в мессенджере.',
    'Пиши так, будто ты живой сотрудник: естественно, без канцелярита и без признаков того, что ты ИИ.',
    'НИКОГДА не упоминай, что ты бот/ИИ/ассистент. Не извиняйся за то, что ты программа.',
    'Отвечай ОДНИМ сообщением, как в чате — коротко, живо, по-русски.',
    '',
    `ТОН: ${toneLine(input.tone)}`,
  ]

  if (input.persona.trim()) {
    parts.push('', 'О КОМПАНИИ И ПРАВИЛАХ ОБЩЕНИЯ:', input.persona.trim())
  }

  if (input.playbook.length > 0) {
    parts.push(
      '',
      'ПЛЕЙБУК (следуй этим правилам, выведенным из практики):',
      ...input.playbook.slice(0, 20).map((p) => `- ${p}`),
    )
  }

  if (input.lessons.length > 0) {
    parts.push(
      '',
      'ПРИМЕРЫ ХОРОШИХ ОТВЕТОВ (как отвечать в похожих ситуациях):',
      ...input.lessons.slice(0, 8).map((l) => {
        const situation = l.situation.trim() || '(общая ситуация)'
        const note = l.note?.trim() ? ` [важно: ${l.note.trim()}]` : ''
        return `• Клиент: "${situation}" → Ответ: "${l.corrected.trim()}"${note}`
      }),
    )
  }

  return parts.join('\n')
}

interface GatewayChoice {
  message?: { content?: string | null }
}
interface GatewayResponse {
  choices?: GatewayChoice[]
}

const REFUSAL = [
  'i cannot',
  'i can’t',
  "i can't",
  'as an ai',
  'как ии',
  'как языковая модель',
  'я не могу помочь',
]

function looksLikeRefusal(text: string): boolean {
  const t = text.toLowerCase()
  return REFUSAL.some((r) => t.includes(r))
}

/** Human hint for common AI Gateway HTTP failures (shown in the logs tab). */
function gatewayStatusHint(status: number): string {
  if (status === 401 || status === 403)
    return ' — ключ AI Gateway недействителен или не имеет доступа (проверьте AI_GATEWAY_API_KEY).'
  if (status === 402)
    return ' — на аккаунте AI Gateway закончились средства/кредиты (пополните баланс).'
  if (status === 429)
    return ' — превышен лимит запросов (rate limit), попробуйте позже.'
  if (status >= 500) return ' — временная ошибка на стороне AI Gateway.'
  return ''
}

/**
 * Generate ONE in-character manager reply for the current conversation.
 * Returns the trimmed reply, or null when the AI is unavailable / declined /
 * produced nothing usable (callers should then stay silent, never post junk).
 */
export async function generateManagerReply(
  input: ManagerBrainInput,
  log?: BrainLog,
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

  // Only recent turns — keeps it cheap and focused.
  const recent = input.history.slice(-16)
  const messages: Array<{ role: string; content: string }> = [
    { role: 'system', content: buildSystemPrompt(input) },
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
    message: `Генерирую ответ (${MODEL}), реплик в контексте: ${recent.length}.`,
    meta: { model: MODEL, turns: recent.length },
  })

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        temperature: 0.7,
        max_tokens: 400,
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
      return null
    }
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    const clean = raw.trim().replace(/^["'«»]+|["'«»]+$/g, '')
    if (!clean) {
      log?.({
        level: 'warn',
        event: 'reply.empty',
        message: 'Модель вернула пустой ответ — ничего не отправлено.',
      })
      return null
    }
    if (looksLikeRefusal(clean)) {
      log?.({
        level: 'warn',
        event: 'reply.refused',
        message: `Ответ отброшен (похож на отказ/«я ИИ»): "${clean.slice(0, 160)}"`,
      })
      return null
    }
    log?.({
      level: 'info',
      event: 'reply.generated',
      message: clean,
    })
    return clean
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.warn('[manager-brain] generation failed:', msg)
    log?.({
      level: 'error',
      event: 'gateway.exception',
      message: `Сбой запроса к AI Gateway: ${msg}`,
    })
    return null
  }
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
): Promise<boolean> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) return false
  // Need at least a couple of turns to judge readiness.
  const recent = history.slice(-16)
  if (recent.filter((m) => m.role === 'client').length === 0) return false

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
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Ты анализируешь переписку менеджера с клиентом. Определи, ГОТОВ ли клиент ' +
              'предоставить свои данные (телефон/контакты/реквизиты) и начать работу/сотрудничество. ' +
              'Отвечай СТРОГО одним словом: "ДА" — если клиент явно согласился и готов начать; ' +
              '"НЕТ" — если ещё сомневается, задаёт вопросы, отказывается или неясно. ' +
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
    const negative = tokens.some((t) => t === 'нет' || t === 'no' || t === 'not')
    const affirmative = tokens.some((t) => t === 'да' || t === 'yes' || t === 'готов')
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
 * Distill a compact bullet-point playbook from the full lesson corpus. Called
 * after training so the always-injected playbook stays small. Falls back to a
 * simple heuristic (dedup of correction gists) when the AI is unavailable.
 */
export async function distillPlaybook(
  lessons: BrainLesson[],
  existingPersona: string,
): Promise<string[]> {
  const key = process.env.AI_GATEWAY_API_KEY
  const corpus = lessons
    .slice(0, 60)
    .map(
      (l, i) =>
        `${i + 1}. Ситуация: ${l.situation.trim() || '—'}\n   Ответ: ${l.corrected.trim()}${
          l.note?.trim() ? `\n   Заметка: ${l.note.trim()}` : ''
        }`,
    )
    .join('\n')

  if (!key || lessons.length === 0) {
    // Heuristic fallback: short, unique corrected-answer gists.
    return lessons
      .slice(0, 12)
      .map((l) => l.note?.trim() || l.corrected.trim())
      .filter(Boolean)
  }

  try {
    const res = await fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          {
            role: 'system',
            content:
              'Ты анализируешь примеры переписки менеджера с клиентами и выводишь краткий свод правил (плейбук). ' +
              'Верни 5–15 коротких правил на русском, каждое с новой строки, без нумерации и лишнего текста. ' +
              'Правила должны обобщать, КАК отвечать клиентам: тон, что предлагать, чего избегать, как вести к сделке.',
          },
          {
            role: 'user',
            content:
              (existingPersona.trim()
                ? `Контекст компании:\n${existingPersona.trim()}\n\n`
                : '') + `Примеры:\n${corpus}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 600,
      }),
    })
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    const rules = raw
      .split('\n')
      .map((l) => l.replace(/^[\s\d.)*-]+/, '').trim())
      .filter((l) => l.length > 0)
      .slice(0, 15)
    return rules.length > 0 ? rules : []
  } catch (err) {
    console.warn(
      '[manager-brain] distill failed:',
      err instanceof Error ? err.message : String(err),
    )
    return lessons
      .slice(0, 12)
      .map((l) => l.note?.trim() || l.corrected.trim())
      .filter(Boolean)
  }
}
