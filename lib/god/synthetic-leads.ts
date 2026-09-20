import 'server-only'

/**
 * ИИ-генератор правдоподобных «лидов» для god-мессенджера.
 *
 * По образцам реальных диалогов (первые входящие сообщения клиентов + их имена
 * и хэндлы) модель придумывает `count` НОВЫХ лидов, каждый из которых:
 *   - name    — имя/никнейм контакта в стиле образцов;
 *   - handle  — идентификатор контакта в стиле образцов (id123456789, @nick);
 *   - message — короткое первое сообщение, будто клиент только что написал.
 *
 * Работает через AI Gateway (`generateObject`, модель GOD_SYNTH_MODEL). Если
 * gateway не настроен (нет ключа) или упал — детерминированный офлайн-фолбэк на
 * основе тех же образцов, чтобы генерация никогда не падала целиком.
 *
 * ВАЖНО: это НЕ переписка с клиентом. Создаётся только ВСТУПИТЕЛЬНОЕ входящее
 * сообщение — дальше диалог живёт как обычный god-synthetic тред.
 */
import { generateObject } from 'ai'
import { z } from 'zod'
import { isBrainConfigured } from '@/lib/ai/brain/core'

/** Модель для генерации лидов. Переопределяется GOD_SYNTH_MODEL. */
const MODEL = process.env.GOD_SYNTH_MODEL || 'openai/gpt-4.1-mini'

const MAX_LEADS = 100
const MAX_NAME_LEN = 60
const MAX_HANDLE_LEN = 64
const MAX_MESSAGE_LEN = 400

export interface SyntheticLead {
  name: string
  handle: string
  message: string
}

export interface SyntheticLeadSamples {
  /** Примеры первых входящих сообщений клиентов. */
  intros: string[]
  /** Примеры имён контактов. */
  names: string[]
  /** Примеры хэндлов/идентификаторов контактов. */
  handles: string[]
}

const leadSchema = z.object({
  leads: z.array(
    z.object({
      name: z.string(),
      handle: z.string(),
      message: z.string(),
    }),
  ),
})

/**
 * Сгенерировать `count` синтетических лидов по образцам. Всегда возвращает
 * ровно `count` элементов (недобор добивается офлайн-фолбэком).
 */
export async function generateSyntheticLeads(
  count: number,
  samples: SyntheticLeadSamples,
): Promise<SyntheticLead[]> {
  const n = clampCount(count)

  if (!isBrainConfigured()) return offlineLeads(n, samples)

  try {
    const { object } = await generateObject({
      model: MODEL,
      schema: leadSchema,
      temperature: 1,
      system:
        'Ты анализируешь реальные диалоги отдела продаж и придумываешь новых ' +
        'правдоподобных ЛИДОВ (клиентов), которые ТОЛЬКО ЧТО написали первое ' +
        'сообщение менеджеру. Для каждого лида верни: ' +
        '"name" — имя или никнейм контакта в стиле примеров; ' +
        '"handle" — идентификатор контакта в стиле примеров (например ' +
        'id987654321 или @nickname), НЕ повторяй примеры дословно; ' +
        '"message" — короткое первое сообщение клиента (вопрос/интерес по теме) ' +
        'в стиле примеров, по-русски, живо и по-человечески, без markdown. ' +
        'Делай лидов разнообразными: разные формулировки, интересы и стиль. ' +
        'Верни РОВНО запрошенное количество лидов.',
      prompt: buildPrompt(n, samples),
      maxOutputTokens: Math.min(4000, 200 + n * 60),
    })

    const cleaned = normalizeLeads(object.leads)
    if (cleaned.length === 0) return offlineLeads(n, samples)
    if (cleaned.length >= n) return cleaned.slice(0, n)
    // Модель вернула меньше — добиваем детерминированным фолбэком.
    return [...cleaned, ...offlineLeads(n - cleaned.length, samples)].slice(0, n)
  } catch {
    return offlineLeads(n, samples)
  }
}

/* ------------------------------- helpers -------------------------------- */

function clampCount(count: number): number {
  const c = Math.round(Number(count) || 0)
  return Math.max(1, Math.min(MAX_LEADS, c))
}

function buildPrompt(n: number, samples: SyntheticLeadSamples): string {
  const intros = pickSome(samples.intros, 25)
  const names = pickSome(samples.names, 30)
  const handles = pickSome(samples.handles, 30)

  const parts: string[] = [`Нужно придумать ${n} новых лидов.`]
  if (intros.length) {
    parts.push(
      'Примеры первых сообщений клиентов:\n' +
        intros.map((s) => `- ${oneLine(s)}`).join('\n'),
    )
  }
  if (names.length) {
    parts.push('Примеры имён контактов:\n' + names.map((s) => `- ${oneLine(s)}`).join('\n'))
  }
  if (handles.length) {
    parts.push(
      'Примеры хэндлов контактов:\n' + handles.map((s) => `- ${oneLine(s)}`).join('\n'),
    )
  }
  if (!intros.length && !names.length && !handles.length) {
    parts.push(
      'Образцов нет — придумай реалистичных клиентов мессенджера с короткими ' +
        'вступительными вопросами по продажам.',
    )
  }
  return parts.join('\n\n')
}

function normalizeLeads(leads: Array<{ name: string; handle: string; message: string }>): SyntheticLead[] {
  const out: SyntheticLead[] = []
  const seenHandles = new Set<string>()
  for (const l of leads) {
    const name = clampText(l?.name, MAX_NAME_LEN)
    let handle = clampText(l?.handle, MAX_HANDLE_LEN).replace(/\s+/g, '')
    const message = clampText(l?.message, MAX_MESSAGE_LEN)
    if (!name || !handle || !message) continue
    // Уникализируем хэндлы, чтобы не плодить дубли-контакты.
    if (seenHandles.has(handle.toLowerCase())) {
      handle = `${handle}${Math.floor(Math.random() * 900 + 100)}`
    }
    seenHandles.add(handle.toLowerCase())
    out.push({ name, handle, message })
  }
  return out
}

function clampText(value: unknown, max: number): string {
  const s = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : ''
  return s.length <= max ? s : s.slice(0, max).trim()
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 200)
}

function pickSome<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr
  // Стабильный срез первых max — образцы уже приходят в случайном порядке из БД.
  return arr.slice(0, max)
}

/* --------------------------- Offline fallback --------------------------- */

const FALLBACK_INTROS = [
  'Здравствуйте! Подскажите, пожалуйста, по условиям.',
  'Добрый день, интересует ваш продукт. Можно подробнее?',
  'Привет! Сколько стоит и как оформить?',
  'Здравствуйте, увидел рекламу — расскажите, что предлагаете?',
  'Добрый день! Хочу узнать детали, актуально ещё?',
  'Здравствуйте, а есть возможность обсудить сотрудничество?',
  'Привет, подскажите сроки и цену, пожалуйста.',
  'Добрый день, интересно, как это работает?',
]

const FALLBACK_NAMES = [
  'Александр',
  'Мария',
  'Дмитрий',
  'Елена',
  'Сергей',
  'Анна',
  'Иван',
  'Ольга',
  'Максим',
  'Наталья',
]

/**
 * Детерминированный (без модели) генератор: комбинирует образцы с случайными
 * суффиксами так, чтобы получить `n` непохожих друг на друга лидов. Хуже
 * модели, но генерация всегда завершается.
 */
export function offlineLeads(count: number, samples: SyntheticLeadSamples): SyntheticLead[] {
  const n = clampCount(count)
  const intros = samples.intros.length ? samples.intros : FALLBACK_INTROS
  const names = samples.names.length ? samples.names : FALLBACK_NAMES
  const handleStyles = samples.handles.filter(Boolean)

  const out: SyntheticLead[] = []
  const seen = new Set<string>()
  let guard = 0
  while (out.length < n && guard < n * 20) {
    guard++
    const name = clampText(pickRandom(names), MAX_NAME_LEN) || 'Клиент'
    const message = clampText(pickRandom(intros), MAX_MESSAGE_LEN) || FALLBACK_INTROS[0]
    const handle = randomHandle(handleStyles)
    if (seen.has(handle.toLowerCase())) continue
    seen.add(handle.toLowerCase())
    out.push({ name, handle, message })
  }
  return out.slice(0, n)
}

/** Хэндл в стиле образцов: если примеры начинаются с @/id — сохраняем стиль. */
function randomHandle(styles: string[]): string {
  const digits = () => String(Math.floor(Math.random() * 9_000_000_000) + 1_000_000_000)
  const sample = styles.length ? pickRandom(styles) : ''
  if (sample.startsWith('@')) {
    return `@user${Math.floor(Math.random() * 900_000 + 100_000)}`
  }
  if (/^id\d/i.test(sample)) {
    return `id${digits()}`
  }
  return `id${digits()}`
}

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}
