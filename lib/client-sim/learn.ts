import { generateText } from 'ai'
import type { LearnedProfile } from './types'
import { aiConfigured } from './generate'
import { type CorpusDialogue, sampleRealDialogues, saveLearnedProfile } from './store'

// Analysis model is INTENTIONALLY separate from the chat model
// (CLIENT_SIM_MODEL). This is the offline "learn from real dialogues" pass, so a
// cheaper model is fine and — crucially — tuning the live chat model must not
// silently change how analysis runs. Defaults to gpt-4.1-mini; override with
// CLIENT_SIM_LEARN_MODEL.
const MODEL = process.env.CLIENT_SIM_LEARN_MODEL || 'openai/gpt-4.1-mini'

// We study EVERY real dialogue, not just the most recent handful. To stay within
// model context limits we do it map-reduce style: analyse the corpus in batches
// (map), then synthesise all batch notes into one profile (reduce). These knobs
// bound the work; override the batch size with CLIENT_SIM_LEARN_BATCH.
const MAX_DIALOGUES = Number(process.env.CLIENT_SIM_LEARN_MAX || 5000)
const BATCH_SIZE = Math.max(8, Number(process.env.CLIENT_SIM_LEARN_BATCH || 25))
const LINES_PER_DIALOGUE = 14

export class LearnError extends Error {}

/**
 * Read real conversations and distill a style/behaviour profile the simulator
 * can imitate. Studies ALL available real dialogues (batched map-reduce so the
 * whole corpus is covered without blowing the model's context), then persists
 * the result and returns it for display.
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

  const dialogues = await sampleRealDialogues(MAX_DIALOGUES, LINES_PER_DIALOGUE)
  const messageCount = dialogues.reduce((n, d) => n + d.lines.length, 0)
  if (dialogues.length === 0 || messageCount < 4) {
    throw new LearnError(
      'Недостаточно реальных диалогов для обучения. Нужно, чтобы в чатах уже была живая переписка с клиентами.',
    )
  }

  const channels = Array.from(new Set(dialogues.map((d) => d.channelType)))

  // ---- MAP: analyse the corpus in batches so we actually read all of it ----
  const batches = chunk(dialogues, BATCH_SIZE)
  const notes: BatchNotes[] = []
  for (let i = 0; i < batches.length; i++) {
    try {
      const note = await analyzeBatch(batches[i], i + 1, batches.length)
      if (note) notes.push(note)
    } catch (err) {
      // A single failed batch shouldn't sink the whole learn run — skip it and
      // keep going; the reduce step still has the rest of the corpus.
      console.log(
        '[client-sim] learn batch failed, skipping:',
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  if (notes.length === 0) {
    throw new LearnError('ИИ вернул ответ, который не удалось разобрать. Попробуйте ещё раз.')
  }

  // ---- REDUCE: synthesise all batch notes into one diverse profile ----
  const parsed = await synthesizeProfile(notes, dialogues.length, messageCount)
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

/* ------------------------------- map step ------------------------------- */

interface BatchNotes {
  toneNotes: string[]
  commonTopics: string[]
  stylePointers: string[]
  samplePhrases: string[]
}

/** Analyse one batch of dialogues into structured observations. */
async function analyzeBatch(
  dialogues: CorpusDialogue[],
  index: number,
  total: number,
): Promise<BatchNotes | null> {
  const corpus = dialogues
    .map((d, i) => {
      const body = d.lines
        .map((l) => `${l.role === 'client' ? 'КЛИЕНТ' : 'МЕНЕДЖЕР'}: ${l.body}`)
        .join('\n')
      return `— Диалог ${i + 1} (${d.channelType}) —\n${body}`
    })
    .join('\n\n')

  const system = [
    'Ты — аналитик разговорного стиля. Тебе дают реальные переписки клиентов с менеджерами.',
    'Твоя задача: понять, КАК пишут реальные клиенты (люди), во всём их РАЗНООБРАЗИИ.',
    'Анализируй ТОЛЬКО реплики со стороны КЛИЕНТ. Реплики МЕНЕДЖЕР — только контекст.',
    'Важно: НЕ усредняй. Улавливай РАЗНЫЕ типы людей: вежливые и грубые, многословные и односложные, доверчивые и подозрительные, спокойные и вспыльчивые. Фиксируй эти различия.',
    '',
    'Верни СТРОГО валидный JSON (без markdown, без пояснений):',
    '{',
    '  "toneNotes": ["наблюдения про тон/эмоции и их РАЗБРОС, 3-6 пунктов"],',
    '  "commonTopics": ["о чём клиенты спрашивают/пишут, 3-6 пунктов"],',
    '  "stylePointers": ["конкретные приёмы письма реальных клиентов: длина, пунктуация, регистр, опечатки, сокращения, 3-6 пунктов"],',
    '  "samplePhrases": ["6-10 РАЗНЫХ характерных дословных фраз клиентов из этих диалогов, охватывающих разные стили"]',
    '}',
    'Все значения — на русском языке.',
  ].join('\n')

  const { text } = await generateText({
    model: MODEL,
    system,
    messages: [
      {
        role: 'user',
        content: `Партия ${index}/${total}. Вот ${dialogues.length} реальных диалогов. Изучи реплики клиентов и верни JSON.\n\n${corpus}`,
      },
    ],
    temperature: 0.5,
    maxOutputTokens: 800,
  })

  const obj = parseJsonObject(text)
  if (!obj) return null
  return {
    toneNotes: toStringArray(obj.toneNotes, 6),
    commonTopics: toStringArray(obj.commonTopics, 6),
    stylePointers: toStringArray(obj.stylePointers, 6),
    samplePhrases: toStringArray(obj.samplePhrases, 10),
  }
}

/* ----------------------------- reduce step ------------------------------ */

interface ParsedProfile {
  summary: string
  toneNotes: string[]
  commonTopics: string[]
  stylePointers: string[]
  samplePhrases: string[]
}

/**
 * Merge all batch notes into a single profile. Pre-dedupes each bucket, then
 * asks the model to consolidate while PRESERVING the diversity across client
 * types (so the simulator gets a rich palette, not a bland average).
 */
async function synthesizeProfile(
  notes: BatchNotes[],
  dialogueCount: number,
  messageCount: number,
): Promise<ParsedProfile | null> {
  const merged = {
    toneNotes: dedupe(notes.flatMap((n) => n.toneNotes)),
    commonTopics: dedupe(notes.flatMap((n) => n.commonTopics)),
    stylePointers: dedupe(notes.flatMap((n) => n.stylePointers)),
    samplePhrases: dedupe(notes.flatMap((n) => n.samplePhrases)),
  }

  const system = [
    'Ты — старший аналитик. Тебе дают сырые наблюдения о том, как пишут реальные клиенты,',
    `собранные по ${dialogueCount} диалогам (${messageCount} сообщений), разбитым на партии.`,
    'Своди их в один итоговый профиль. ГЛАВНОЕ: сохрани РАЗНООБРАЗИЕ — не превращай всё в один',
    '"средний" голос. Профиль должен помочь ИИ достоверно играть тысячи РАЗНЫХ людей.',
    '',
    'Верни СТРОГО валидный JSON (без markdown):',
    '{',
    '  "summary": "3-5 предложений: какой РАЗБРОС стилей и типов клиентов ты увидел",',
    '  "toneNotes": ["6-10 пунктов про тон/эмоции и их вариативность"],',
    '  "commonTopics": ["6-10 пунктов: о чём пишут клиенты"],',
    '  "stylePointers": ["8-14 конкретных приёмов письма, охватывающих РАЗНЫЕ манеры"],',
    '  "samplePhrases": ["12-20 РАЗНЫХ дословных фраз, охватывающих весь спектр стилей"]',
    '}',
    'Все значения — на русском.',
  ].join('\n')

  const { text } = await generateText({
    model: MODEL,
    system,
    messages: [
      {
        role: 'user',
        content: `Сырые наблюдения (JSON):\n${JSON.stringify(merged)}`,
      },
    ],
    temperature: 0.4,
    maxOutputTokens: 1400,
  })

  const obj = parseJsonObject(text)
  if (!obj) {
    // Fallback: if the reduce call fails to parse, still return the merged raw
    // buckets so a learn run never comes back empty after reading everything.
    if (merged.stylePointers.length || merged.toneNotes.length) {
      return {
        summary: `Изучено ${dialogueCount} диалогов (${messageCount} сообщений). Клиенты пишут по-разному — от вежливых развёрнутых сообщений до грубых односложных.`,
        toneNotes: merged.toneNotes.slice(0, 10),
        commonTopics: merged.commonTopics.slice(0, 10),
        stylePointers: merged.stylePointers.slice(0, 14),
        samplePhrases: merged.samplePhrases.slice(0, 20),
      }
    }
    return null
  }

  const summary = typeof obj.summary === 'string' ? obj.summary.trim() : ''
  const profile: ParsedProfile = {
    summary,
    toneNotes: toStringArray(obj.toneNotes, 10),
    commonTopics: toStringArray(obj.commonTopics, 10),
    stylePointers: toStringArray(obj.stylePointers, 14),
    samplePhrases: toStringArray(obj.samplePhrases, 20),
  }
  if (!profile.summary && profile.stylePointers.length === 0) return null
  return profile
}

/* ------------------------------- helpers -------------------------------- */

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** Case-insensitive dedupe that keeps first occurrence and drops blanks. */
function dedupe(items: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of items) {
    const s = raw.trim()
    if (!s) continue
    const key = s.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(s)
  }
  return out
}

/** Defensively extract the outermost JSON object from model output. */
function parseJsonObject(text: string): Record<string, unknown> | null {
  if (!text) return null
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

function toStringArray(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return []
  return v
    .map((x) => (typeof x === 'string' ? x.trim() : ''))
    .filter(Boolean)
    .slice(0, limit)
}
