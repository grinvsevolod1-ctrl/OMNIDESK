import 'server-only'

/**
 * ИИ-черновик для рассылки по группам подработок.
 *
 *   generateBase(context)      — из контекста владельца формирует один
 *                                «человеческий» пост (не спам, без markdown).
 *   varyForGroup(base, title)  — уникальный вариант ПОД КАЖДУЮ группу, чтобы
 *                                антиспам-фильтры не резали идентичные тексты.
 *
 * Вариация — это не косметика, а защита от бана: Telegram-группы с защитой от
 * рассылок отсекают одинаковые сообщения. Каждый вариант сохраняет смысл, но
 * заметно отличается формулировкой, порядком и деталями.
 *
 * Работает через AI Gateway (`generateText`, модель BROADCAST_MODEL). Если
 * gateway не настроен (нет ключа) или упал — используется ДЕТЕРМИНИРОВАННЫЙ
 * офлайн-фолбэк, чтобы кампания никогда не падала целиком из-за модели.
 */
import { generateText } from 'ai'
import { isBrainConfigured } from '@/lib/ai/brain/core'

/** Модель для черновика/вариаций. Переопределяется BROADCAST_MODEL. */
const BROADCAST_MODEL = process.env.BROADCAST_MODEL || 'openai/gpt-4.1-mini'

/** Верхняя граница длины поста — короткие сообщения меньше похожи на спам. */
const MAX_LEN = 600

/**
 * Базовый пост из контекста владельца. Один вызов модели; при недоступности
 * gateway возвращает нормализованный контекст как есть (детерминированно).
 */
export async function generateBase(context: string): Promise<string> {
  const trimmed = context.trim()
  if (!trimmed) return ''
  if (!isBrainConfigured()) return offlineBase(trimmed)

  try {
    const { text } = await generateText({
      model: BROADCAST_MODEL,
      system:
        'Ты помогаешь составить короткое объявление для групп по поиску подработок. ' +
        'Пиши по-русски, живо и по-человечески, от первого лица. ' +
        'Без markdown, без хэштегов, без обилия эмодзи (максимум один). ' +
        'Не обещай нереального, не проси предоплату. 2–4 коротких предложения. ' +
        'Верни ТОЛЬКО текст объявления, без пояснений.',
      prompt: `Контекст объявления: ${trimmed}`,
      maxOutputTokens: 400,
    })
    const cleaned = clamp(text.trim())
    return cleaned || offlineBase(trimmed)
  } catch {
    return offlineBase(trimmed)
  }
}

/**
 * Уникальный вариант базового поста под конкретную группу. `groupTitle` даёт
 * модели контекст аудитории, но НЕ вставляется дословно (это выглядело бы как
 * шаблон-подстановка). При недоступности gateway — детерминированная вариация.
 */
export async function varyForGroup(
  base: string,
  groupTitle: string,
): Promise<string> {
  const trimmed = base.trim()
  if (!trimmed) return ''
  if (!isBrainConfigured()) return offlineVariant(trimmed, groupTitle)

  try {
    const { text } = await generateText({
      model: BROADCAST_MODEL,
      // Заметная, но осмысленная вариация: перефразируй, поменяй порядок мыслей,
      // синонимы — смысл и предложение те же.
      temperature: 0.9,
      system:
        'Перепиши объявление другими словами, сохранив смысл и предложение. ' +
        'Измени формулировки, порядок предложений и часть лексики так, чтобы ' +
        'текст заметно отличался от оригинала (обход антиспам-фильтров на ' +
        'одинаковые сообщения). По-русски, живо, без markdown и хэштегов, ' +
        'максимум один эмодзи. Верни ТОЛЬКО новый текст.',
      prompt:
        `Аудитория группы: «${groupTitle}».\n` +
        `Оригинал объявления:\n${trimmed}`,
      maxOutputTokens: 400,
    })
    const cleaned = clamp(text.trim())
    return cleaned || offlineVariant(trimmed, groupTitle)
  } catch {
    return offlineVariant(trimmed, groupTitle)
  }
}

/**
 * Разные тексты ПОД КАЖДЫЙ аккаунт для массовой рассылки. Из одной темы
 * владельца формирует `count` заметно отличающихся постов — чтобы аккаунты не
 * постили идентичное (выглядит органично + антиспам). Генерит базу один раз,
 * затем делает по варианту на аккаунт (переиспользует ту же логику вариации,
 * что и под группы). При недоступности gateway — детерминированный фолбэк.
 */
export async function generateDistinctBases(
  context: string,
  count: number,
): Promise<string[]> {
  const trimmed = context.trim()
  const n = Math.max(1, count)
  if (!trimmed) return Array.from({ length: n }, () => '')

  const base = await generateBase(trimmed)
  if (n === 1) return [base]

  // Последовательно, чтобы не бить по gateway залпом; аккаунтов обычно немного.
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    out.push(await varyForGroup(base, `аккаунт-${i + 1}`))
  }
  return out
}

/* --------------------------- Deterministic fallback -------------------------- */

/** Normalize whitespace and clamp length. Used by both online and offline. */
function clamp(text: string): string {
  const oneSpace = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  if (oneSpace.length <= MAX_LEN) return oneSpace
  // Cut on a sentence boundary near the limit when possible.
  const slice = oneSpace.slice(0, MAX_LEN)
  const lastStop = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('! '),
    slice.lastIndexOf('? '),
  )
  return (lastStop > MAX_LEN * 0.5 ? slice.slice(0, lastStop + 1) : slice).trim()
}

function offlineBase(context: string): string {
  return clamp(context)
}

/**
 * Deterministic variation without a model: rotate a few neutral openers and
 * light connective tweaks keyed off the group title so two groups don't get a
 * byte-identical message. Not as good as the model, but keeps sends flowing and
 * still avoids exact-duplicate filters.
 */
const OPENERS = [
  'Всем привет!',
  'Доброго дня!',
  'Привет всем в чате.',
  'Здравствуйте!',
  'Добрый день, коллеги.',
  'Приветствую!',
]

function offlineVariant(base: string, groupTitle: string): string {
  const idx = hashString(groupTitle) % OPENERS.length
  const opener = OPENERS[idx]
  // Strip a leading greeting already present in the base to avoid doubling.
  const body = base.replace(
    /^(всем привет|доброго дня|привет всем[^.!?]*|здравствуйте|добрый день[^.!?]*|приветствую)[.!,]?\s*/i,
    '',
  )
  return clamp(`${opener} ${body}`)
}

/** Small stable string hash (djb2) for deterministic opener selection. */
function hashString(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}
