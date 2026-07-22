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
  /**
   * Strict, hand-written corrections the admin taught on specific messages.
   * These are ALWAYS injected and take absolute priority — the AI must never
   * repeat a mistake it was corrected on. Optional for older callers.
   */
  corrections?: string[]
  /** Conversation so far, oldest → newest. */
  history: BrainMessage[]
}

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions'

// gpt-4.1 gives the most coherent, context-aware replies to real clients — the
// priority for customer-facing messages. Override with MANAGER_AI_MODEL, or at
// runtime via BrainConfig.model (admin panel setting) which takes precedence.
const MODEL = process.env.MANAGER_AI_MODEL || 'openai/gpt-4.1'
const DEFAULT_TEMPERATURE = 0.7
const DEFAULT_MAX_TOKENS = 400

/**
 * Optional per-call model configuration, resolved by the CALLER from the admin
 * settings (keeps this module dependency-free — it never reads the DB itself).
 * Any field left undefined/empty falls back to the built-in defaults, so old
 * callers that pass nothing behave exactly as before.
 */
export interface BrainConfig {
  model?: string | null
  temperature?: number | null
  maxTokens?: number | null
}

function resolveModel(config?: BrainConfig): string {
  const m = config?.model?.trim()
  return m || MODEL
}

/** Structured metric emitted once per gateway call via the BrainLog sink. */
export interface BrainMetric {
  purpose: 'reply' | 'assess'
  model: string
  outcome: 'ok' | 'empty' | 'refused' | 'http_error' | 'exception'
  latencyMs: number
  promptTokens?: number
  completionTokens?: number
}

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
  const persona = input.persona.trim()

  const parts: string[] = [
    'Ты — живой менеджер компании, который лично ведёт переписку с клиентом в мессенджере.',
    'Пиши так, будто ты реальный сотрудник: естественно, по-человечески, без канцелярита.',
    '',
    'ЖЁСТКИЕ ПРАВИЛА ЛИЧНОСТИ (нарушать нельзя):',
    '- Ты ЧЕЛОВЕК. Ты НИКОГДА и ни при каких условиях не признаёшься, что ты бот, ИИ, нейросеть, ассистент или программа.',
    '- Если клиент прямо спрашивает «ты бот?/это робот?/ты человек?/ии?» — спокойно и уверенно отвечай, что ты живой сотрудник (например: «Живой-живой, менеджер компании 🙂 Чем помочь?»), и сразу продолжай вести диалог по делу. Не оправдывайся, не уходи в объяснения.',
    '- Не пиши как робот: без списков-инструкций, без «как я могу помочь вам сегодня», без официоза. Пиши так, как переписываются живые люди.',
    '',
    'КАК ПИСАТЬ (чтобы тебя невозможно было принять за ИИ):',
    '- НИКОГДА не используй длинное тире «—» или среднее тире «–». Пиши как в живом чате: короткими фразами, через запятую, точку или обычный дефис «-».',
    '- Не используй маркированные/нумерованные списки, заголовки, markdown, жирный шрифт, звёздочки. Только обычный текст.',
    '- Не пиши вводных штампов ИИ: «Конечно!», «Разумеется!», «Рад помочь», «Отличный вопрос», «Давайте разберёмся», «Как я могу помочь». Начинай сразу по делу.',
    '- Живой разговорный русский: допустимы простые смайлики, короткие предложения, естественные обороты. Без канцелярита и пафоса.',
    '',
    'ЕДИНСТВЕННЫЙ РЕЖИМ — МАКСИМАЛЬНАЯ НАСТОЙЧИВОСТЬ (никогда не сдавайся, никогда не соглашайся с возражением):',
    '- У компании ОДНА вакансия/одно предложение — то, что описано в блоке «СЦЕНАРИЙ И ПРАВИЛА РУКОВОДИТЕЛЯ» ниже. Ты ведёшь клиента ТОЛЬКО по нему. Других вариантов, вакансий, условий, скидок и альтернатив НЕ существует и ты их НЕ придумываешь и НЕ предлагаешь.',
    '- Ты НИКОГДА не соглашаешься с возражением клиента и НИКОГДА не подстраиваешься под него. Если клиента что-то «не устраивает» — это возражение, которое нужно отработать и мягко вернуть его к нашему единственному предложению, а НЕ повод менять условия или соглашаться, что оно ему не подходит.',
    '- Не поддакивай в ущерб цели. Можно проявить понимание («понимаю вас»), но сразу же вернуть разговор к нашему предложению и его выгодам. Никогда не говори «да, вам это не подходит», «поищите другое», «согласен, условия так себе».',
    '- Твоя цель — довести клиента до готовности предоставить документы или нужный перечень данных для трудоустройства, которые ты у него запрашиваешь. Это финальная т��чка.',
    '- Мягкое «нет», сомнения, отговорки, «я подумаю», «дорого», «неудобно», молчание — это НЕ отказ, а возражение. Признай эмоцию, сними страх, покажи выгоду именно нашего предложения и снова подтолкни к следующему шагу.',
    '- Всегда заканчивай сообщение так, чтобы клиенту было легко сделать шаг вперёд: один конкретный вопрос или мягкий призыв (без давления и агрессии).',
    '- Веди клиента шаг за шагом к тому, чтобы он согласился прислать документы/данные. Не переключай на «человека» сам — ты и есть менеджер.',
    '',
    'НИКОГДА не упоминай, что ты бот/ИИ/ассистент. Не извиняйся за то, что ты программа.',
    'Отвечай ОДНИМ сообщением, как в чате — коротко, живо, по-русски.',
    '',
    `ТОН: ${toneLine(input.tone)}`,
  ]

  // The admin's playbook/persona field is the SINGLE SOURCE OF TRUTH for the
  // offer and the script. Elevate it to the very top of priority and state
  // explicitly that it overrides the model's own ideas — this is what the admin
  // types in the Admin AI tab and it must be obeyed verbatim.
  if (persona) {
    parts.push(
      '',
      'СЦЕНАРИЙ И ПРАВИЛА РУКОВОДИТЕЛЯ (ГЛАВНЫЙ ИСТОЧНИК ИСТИНЫ — соблюдать дословно, важнее любых собственных идей):',
      persona,
      '',
      'Строго следуй этому сценарию. Если твоё «здравое рассуждение» противоречит сценарию — побеждает сценарий. Не выходи за рамки описанного предложения.',
    )
  }

  // Strict manual corrections come next and are marked as top-priority: these
  // are exact mistakes the admin flagged on real messages, and the AI must obey
  // them over any other guidance except the руководитель's scenario above.
  const corrections = (input.corrections ?? [])
    .map((c) => c.trim())
    .filter(Boolean)
  if (corrections.length > 0) {
    parts.push(
      '',
      'КРИТИЧЕСКИ ВАЖНЫЕ ПРАВКИ ОТ РУКОВОДИТЕЛЯ (высший приоритет, соблюдать всегда, никогда не повторять эти ошибки):',
      ...corrections.slice(0, 40).map((c) => `!! ${c}`),
    )
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
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

const REFUSAL = [
  'i cannot',
  'i can’t',
  "i can't",
  'as an ai',
  'как ии',
  'как языковая модель',
  'языковая модель',
  'я не могу помочь',
  'я — искусственный интеллект',
  'я искусственный интеллект',
  'я бот',
  'я — бот',
  'я чат-бот',
  'я чатбот',
  'я нейросеть',
  'я — нейросеть',
  'я виртуальный ассистент',
  'я ассистент',
  'я программа',
  'я всего лишь',
  'я не человек',
]

function looksLikeRefusal(text: string): boolean {
  const t = text.toLowerCase()
  return REFUSAL.some((r) => t.includes(r))
}

/**
 * Scrub the tell-tale signs of AI text so a client can never spot the bot.
 * Applied to EVERY generated reply before it's sent. Purely mechanical and
 * language-safe: it only touches punctuation/markdown artefacts, never rewrites
 * meaning.
 *
 *  - Long/■em/en dashes («—», «–», «―», «‒», «−») are the #1 AI giveaway in
 *    Russian chat. Real people type a comma or a plain hyphen. We convert a
 *    dash used as a clause break (" — ") into a comma, and a stray standalone
 *    dash into a plain hyphen.
 *  - Markdown emphasis (**bold**, *italic*, `code`, ###, leading "- "/"* "
 *    bullets) never appears in a human chat message, so we strip it.
 *  - Collapse the doubled spaces / stray whitespace left behind.
 */
export function humanizeReply(text: string): string {
  let t = text

  // Strip markdown emphasis and headings that a human would never type.
  t = t.replace(/\*\*([^*]+)\*\*/g, '$1') // **bold**
  t = t.replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, '$1$2') // *italic*
  t = t.replace(/`([^`]+)`/g, '$1') // `code`
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, '') // ### headings
  // Leading list bullets ("- ", "* ", "• ", "1. ") at the start of a line.
  t = t.replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')

  // Dashes: the biggest AI tell. Handle the "clause break" form first
  // (space-dash-space → comma-space), then any remaining dash → plain hyphen.
  t = t.replace(/\s*[—–―‒−]\s+/g, ', ') // " — " used as a pause
  t = t.replace(/[—–―‒−]/g, '-') // any leftover long dash → hyphen

  // Tidy: collapse spaces, fix space-before-punctuation, trim.
  t = t.replace(/[ \t]{2,}/g, ' ')
  t = t.replace(/\s+([,.!?;:])/g, '$1')
  t = t.replace(/,\s*,/g, ',')
  t = t.replace(/^[\s,;:]+/, '')

  return t.trim()
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
    log?.({
      level: 'info',
      event: 'reply.generated',
      message: clean,
    })
    emitMetric('ok', data.usage)
    return clean
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
              'Не объясня��, только ДА или НЕТ.',
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
 * Learn an account's real selling STYLE from full manager↔client transcripts
 * and distill it into a compact bullet-point playbook (how this account's
 * managers open, handle objections, push toward documents, close). Used by the
 * per-account trainer in /admin/ai. Returns [] when the AI is unavailable (the
 * caller keeps the existing playbook), so it never destroys prior training.
 */
export async function distillPlaybookFromDialogs(
  transcripts: string[],
  existingPersona: string,
): Promise<string[]> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key || transcripts.length === 0) return []

  // Cap the corpus so the request stays cheap and within context limits.
  const corpus = transcripts
    .slice(0, 40)
    .map((t, i) => `--- Диалог ${i + 1} ---\n${t}`)
    .join('\n\n')
    .slice(0, 24_000)

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
              'Ты изучаешь реальные переписки менеджеров этой компании с клиентами и выводишь свод ' +
              'правил (плейбук), КАК менеджеры ведут клиента к сделке. Сосредоточься на: как ' +
              'открывают диалог, какие вопросы задают, как отрабатывают возражения и сомнения, как ' +
              'настойчиво (но по-человечески) доводят клиента до готовности прислать документы/данные, ' +
              'какие формулировки и тон используют, чего избегают. Верни 8–15 коротких правил на ' +
              'русском, каждое с новой строки, без нумерации и вводных фраз. Правила должны обобщать ' +
              'СТИЛЬ этих менеджеров, чтобы новый сотрудник общался так же.',
          },
          {
            role: 'user',
            content:
              (existingPersona.trim()
                ? `Контекст компании:\n${existingPersona.trim()}\n\n`
                : '') + `Переписки:\n${corpus}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 700,
      }),
    })
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    return raw
      .split('\n')
      .map((l) => l.replace(/^[\s\d.)*-]+/, '').trim())
      .filter((l) => l.length > 0)
      .slice(0, 15)
  } catch (err) {
    console.warn(
      '[manager-brain] distill-from-dialogs failed:',
      err instanceof Error ? err.message : String(err),
    )
    return []
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
