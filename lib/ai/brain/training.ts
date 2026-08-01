/**
 * Training and analysis: distill playbooks from real dialogs/lessons, generate
 * a sales scenario from a business description, and post-mortem lost dialogs
 * into lessons and loss-pattern clusters. Same dependency rules as the rest of
 * lib/ai/brain/ (see core.ts).
 */

import {
  GATEWAY_URL,
  MODEL,
  type BrainLesson,
  type GatewayResponse,
} from './core'

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

/** A ready-to-apply sales setup generated from a plain business description. */
export interface GeneratedScenario {
  /** The persona/scenario blob for ai_assist_settings.persona. */
  persona: string
  /** Concrete rules to store as directives (the chat-driven mandate). */
  directives: string[]
}

/**
 * Turn a plain-language business description ("we sell fitted kitchens, average
 * cheque 300k, main objection is price") into a ready sales setup: a persona
 * (scenario) plus a handful of concrete directives. This is how an admin can
 * bootstrap the whole manager by just describing the business in chat — nothing
 * hardcoded, the model proposes and the admin edits it further via chat.
 * Returns null when the gateway is unavailable so the caller can explain why.
 */
export async function generateSalesScenario(
  businessDescription: string,
): Promise<GeneratedScenario | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  const desc = businessDescription.trim()
  if (!key || !desc) return null

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
              'Ты — эксперт по продажам. По описанию бизнеса ты собираешь настройку ИИ-продавца. ' +
              'Верни СТРОГО JSON без пояснений в форме {"persona": "...", "directives": ["...", "..."]}. ' +
              'persona — связный сценарий на русском (2–5 абзацев): чем занимается компания, кто клиент, что предлагать, тон, как вести к сделке, как закрывать. ' +
              'directives — 5–12 коротких конкретных правил (что всегда делать, чего никогда не делать, как отрабатывать возражения). ' +
              'Пиши живым языком, без канцелярита. Только JSON.',
          },
          { role: 'user', content: `Описание бизнеса:\n${desc}` },
        ],
        temperature: 0.5,
        max_tokens: 1200,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(raw) as {
      persona?: unknown
      directives?: unknown
    }
    const persona =
      typeof parsed.persona === 'string' ? parsed.persona.trim() : ''
    const directives = Array.isArray(parsed.directives)
      ? parsed.directives
          .map((d) => (typeof d === 'string' ? d.trim() : ''))
          .filter(Boolean)
          .slice(0, 12)
      : []
    if (!persona && directives.length === 0) return null
    return { persona, directives }
  } catch (err) {
    console.warn(
      '[manager-brain] scenario generation failed:',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/** One improvement the AI proposes after studying a lost/handed-off dialog. */
export interface ProposedLesson {
  /** The client situation/objection that tripped the AI up. */
  situation: string
  /** How the AI SHOULD have answered next time. */
  corrected: string
  /** Short reason why this is better. */
  note: string
}

/**
 * Study a batch of dialogs that went badly (handed off or lost) and propose
 * concrete lessons: for each recurring failure, the client situation and a
 * better answer. This is how the co-pilot turns losses into training — the
 * admin reviews the proposals in chat and decides which to save. Nothing is
 * persisted here. Returns [] when the gateway is unavailable or nothing useful
 * was found.
 */
export async function analyzeDialogsForLessons(
  transcripts: string[],
): Promise<ProposedLesson[]> {
  const key = process.env.AI_GATEWAY_API_KEY
  const clean = transcripts.map((t) => t.trim()).filter(Boolean).slice(0, 12)
  if (!key || clean.length === 0) return []

  // Cap each transcript so one long thread can't blow the context budget.
  const corpus = clean
    .map((t, i) => `=== Диалог ${i + 1} ===\n${t.slice(0, 2500)}`)
    .join('\n\n')

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
              'Ты — наставник отдела продаж. Тебе дают реальные диалоги, где ИИ-продавец не довёл клиента (передал человеку или клиент ушёл). ' +
              'Найди повторяющиеся ошибки и слабые места. Верни СТРОГО JSON без пояснений в форме {"lessons": [{"situation": "...", "corrected": "...", "note": "..."}]}. ' +
              'situation — реплика/возражение клиента, на котором продавец споткнулся (обобщённо, без личных данных). ' +
              'corrected — как правильно ответить в следующий раз (живой текст, готовый к отправке). ' +
              'note — коротко, почему так лучше. Дай 3–8 самых полезных уроков. Не выдумывай того, чего нет в диалогах. Только JSON.',
          },
          { role: 'user', content: corpus },
        ],
        temperature: 0.4,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(raw) as { lessons?: unknown }
    if (!Array.isArray(parsed.lessons)) return []
    return parsed.lessons
      .map((l) => {
        const o = (l ?? {}) as Record<string, unknown>
        return {
          situation: typeof o.situation === 'string' ? o.situation.trim() : '',
          corrected: typeof o.corrected === 'string' ? o.corrected.trim() : '',
          note: typeof o.note === 'string' ? o.note.trim() : '',
        }
      })
      .filter((l) => l.situation && l.corrected)
      .slice(0, 8)
  } catch (err) {
    console.warn(
      '[manager-brain] lesson analysis failed:',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}

/** One clustered loss cause across a batch of failed dialogs. */
export interface LossPattern {
  /** Human name of the failure cause, e.g. «Возражение по цене». */
  reason: string
  /** How many of the analyzed dialogs died on this cause. */
  dialogCount: number
  /** Share of analyzed dialogs, 0..100 (integer). */
  sharePct: number
  /** A representative (anonymized) client line from the dialogs. */
  evidence: string
  /** Concrete rule/lesson text that would counter this pattern. */
  suggestion: string
}

/**
 * Batch post-mortem: cluster WHY a set of lost dialogs died, with shares and a
 * concrete counter-suggestion per cluster. Differs from analyzeDialogsForLessons
 * (which extracts individual reply-level lessons): this answers the manager
 * question «где мы теряем клиентов и сколько» — 40% на цене, 25% на молчании —
 * so the admin can attack the biggest leak first. Suggestions are proposals
 * only; the caller decides what becomes a rule or lesson.
 */
export async function analyzeLossPatterns(
  transcripts: string[],
): Promise<LossPattern[]> {
  const key = process.env.AI_GATEWAY_API_KEY
  const clean = transcripts.map((t) => t.trim()).filter(Boolean).slice(0, 20)
  if (!key || clean.length === 0) return []

  const corpus = clean
    .map((t, i) => `=== Диалог ${i + 1} ===\n${t.slice(0, 2000)}`)
    .join('\n\n')

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
              `Ты — руководитель отдела продаж, делаешь разбор проигрышей. Тебе дают ${clean.length} реальных диалогов, где клиент не купил (ушёл, замолчал или диалог передали человеку). ` +
              'Сгруппируй ПРИЧИНЫ проигрыша в 2–6 кластеров и оцени, сколько диалогов погибло на каждой причине. Верни СТРОГО JSON без пояснений: ' +
              '{"patterns": [{"reason": "...", "dialogCount": N, "evidence": "...", "suggestion": "..."}]}. ' +
              'reason — короткое имя причины («Возражение по цене», «Долго не отвечали», «Не отработан запрос на примеры»). ' +
              'dialogCount — целое число диалогов этого кластера (сумма по кластерам не больше числа диалогов). ' +
              'evidence — одна характерная реплика клиента, обезличенная. ' +
              'suggestion — конкретное правило или урок для продавца, который закроет эту причину (готовая формулировка). ' +
              'Сортируй кластеры от самой частой причины к редкой. Не выдумывай причин, которых нет в диалогах. Только JSON.',
          },
          { role: 'user', content: corpus },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        response_format: { type: 'json_object' },
      }),
    })
    if (!res.ok) throw new Error(`gateway HTTP ${res.status}`)
    const data = (await res.json()) as GatewayResponse
    const raw = data.choices?.[0]?.message?.content ?? ''
    const parsed = JSON.parse(raw) as { patterns?: unknown }
    if (!Array.isArray(parsed.patterns)) return []
    return parsed.patterns
      .map((p) => {
        const o = (p ?? {}) as Record<string, unknown>
        const dialogCount =
          typeof o.dialogCount === 'number' && Number.isFinite(o.dialogCount)
            ? Math.max(0, Math.min(clean.length, Math.round(o.dialogCount)))
            : 0
        return {
          reason: typeof o.reason === 'string' ? o.reason.trim() : '',
          dialogCount,
          sharePct: Math.round((dialogCount / clean.length) * 100),
          evidence: typeof o.evidence === 'string' ? o.evidence.trim() : '',
          suggestion:
            typeof o.suggestion === 'string' ? o.suggestion.trim() : '',
        }
      })
      .filter((p) => p.reason && p.dialogCount > 0)
      .slice(0, 6)
  } catch (err) {
    console.warn(
      '[manager-brain] loss-pattern analysis failed:',
      err instanceof Error ? err.message : String(err),
    )
    return []
  }
}
