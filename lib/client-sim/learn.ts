import { generateText } from 'ai'
import type { LearnedProfile } from './types'
import { aiConfigured } from './generate'
import { sampleRealDialogues, saveLearnedProfile } from './store'

const MODEL = process.env.CLIENT_SIM_MODEL || 'openai/gpt-4o-mini'

export class LearnError extends Error {}

/**
 * Read real conversations and distill a style/behaviour profile the simulator
 * can imitate. Persists the result and returns it for display.
 *
 * Throws LearnError with a user-facing (Russian) message when it can't run:
 *   - no AI key configured
 *   - not enough real dialogues to learn from
 *   - the model returned something unparseable
 */
export async function analyzeDialogues(): Promise<LearnedProfile> {
  if (!aiConfigured()) {
    throw new LearnError(
      'ИИ-ключ (AI Gateway) не настроен — обучение недоступно. Добавьте AI_GATEWAY_API_KEY.',
    )
  }

  const dialogues = await sampleRealDialogues(40, 12)
  const messageCount = dialogues.reduce((n, d) => n + d.lines.length, 0)
  if (dialogues.length === 0 || messageCount < 4) {
    throw new LearnError(
      'Недостаточно реальных диалогов для обучения. Нужно, чтобы в чатах уже была живая переписка с клиентами.',
    )
  }

  const channels = Array.from(new Set(dialogues.map((d) => d.channelType)))

  // Build a compact, readable corpus for the model.
  const corpus = dialogues
    .slice(0, 40)
    .map((d, i) => {
      const body = d.lines
        .map((l) => `${l.role === 'client' ? 'КЛИЕНТ' : 'МЕНЕДЖЕР'}: ${l.body}`)
        .join('\n')
      return `— Диалог ${i + 1} (${d.channelType}) —\n${body}`
    })
    .join('\n\n')

  const system = [
    'Ты — аналитик разговорного стиля. Тебе дают реальные переписки клиентов с менеджерами.',
    'Твоя задача: понять, КАК пишут реальные клиенты (люди), чтобы потом ИИ мог достоверно их имитировать.',
    'Анализируй ТОЛЬКО реплики со стороны КЛИЕНТ. Реплики МЕНЕДЖЕР — только контекст.',
    'Обрати внимание на: длину сообщений, пунктуацию и регистр, типичные опечатки и сокращения, эмоции и тон, ненормативную лексику, типичные вопросы и темы, манеру начинать и заканчивать разговор.',
    '',
    'Верни СТРОГО валидный JSON (без markdown, без пояснений) следующей формы:',
    '{',
    '  "summary": "2-4 предложения: что ты понял про то, как общаются клиенты",',
    '  "toneNotes": ["наблюдения про тон и эмоции, 3-6 пунктов"],',
    '  "commonTopics": ["о чём клиенты обычно спрашивают/пишут, 3-6 пунктов"],',
    '  "stylePointers": ["конкретные указания как писать чтобы звучать как реальный клиент, 4-8 пунктов"],',
    '  "samplePhrases": ["5-8 коротких характерных фраз клиентов из этих диалогов"]',
    '}',
    'Все значения — на русском языке.',
  ].join('\n')

  let text: string
  try {
    const res = await generateText({
      model: MODEL,
      system,
      messages: [
        {
          role: 'user',
          content: `Вот ${dialogues.length} реальных диалогов (${messageCount} сообщений). Изучи их и верни JSON.\n\n${corpus}`,
        },
      ],
      temperature: 0.4,
      maxOutputTokens: 900,
    })
    text = res.text
  } catch (err) {
    throw new LearnError(
      `Ошибка обращения к ИИ: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const parsed = parseProfileJson(text)
  if (!parsed) {
    throw new LearnError('ИИ вернул ответ, который не удалось разобрать. Попробуйте ещё раз.')
  }

  const profile: LearnedProfile = {
    learnedAt: new Date().toISOString(),
    dialogueCount: dialogues.length,
    messageCount,
    channels,
    summary: parsed.summary,
    toneNotes: parsed.toneNotes,
    commonTopics: parsed.commonTopics,
    stylePointers: parsed.stylePointers,
    samplePhrases: parsed.samplePhrases,
  }

  await saveLearnedProfile(profile)
  return profile
}

/* ------------------------------- parsing -------------------------------- */

interface ParsedProfile {
  summary: string
  toneNotes: string[]
  commonTopics: string[]
  stylePointers: string[]
  samplePhrases: string[]
}

/** Defensively extract the JSON object from the model output. */
function parseProfileJson(text: string): ParsedProfile | null {
  if (!text) return null
  // Strip markdown fences and grab the outermost {...}.
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null

  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(cleaned.slice(start, end + 1))
  } catch {
    return null
  }

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  const profile: ParsedProfile = {
    summary,
    toneNotes: toStringArray(obj.toneNotes),
    commonTopics: toStringArray(obj.commonTopics),
    stylePointers: toStringArray(obj.stylePointers),
    samplePhrases: toStringArray(obj.samplePhrases),
  }
  // Require at least a summary and some pointers to consider it valid.
  if (!profile.summary && profile.stylePointers.length === 0) return null
  return profile
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, 8)
}
