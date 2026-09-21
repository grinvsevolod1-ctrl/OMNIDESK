/**
 * Уникализация первого касания (анти-спам исходящего контура).
 *
 * Telegram агрессивно ловит массовую рассылку БАЙТ-В-БАЙТ одинакового текста
 * разным незнакомцам — это первый триггер спам-блока. Задача этого модуля:
 * сделать каждое первое сообщение уникальным, но при этом
 *   * естественным (человек так пишет),
 *   * не искажающим смысл того, что набрал менеджер,
 *   * ДЕТЕРМИНИРОВАННЫМ по лиду — один лид всегда получает один вариант, чтобы
 *     повторная отправка / ретрай server action не плодили разные тексты.
 *
 * Сознательно НЕ используем невидимые unicode-символы (zero-width space и т.п.):
 * анти-спам палит их первым делом, они выглядят как классический бот-трюк.
 * Вариативность берём только из натуральных вещей: подстановка имени в
 * плейсхолдеры, синоним приветствия в том же регистре вежливости, финальная
 * пунктуация.
 */

export interface VaryLeadContext {
  id: string
  displayName?: string | null
  username?: string | null
}

/** Детерминированный seed из id лида (djb2). */
function seedFrom(id: string): number {
  let h = 5381
  for (let i = 0; i < id.length; i++) {
    h = (h * 33) ^ id.charCodeAt(i)
  }
  return Math.abs(h)
}

/** Первое слово имени, очищенное от мусора — для подстановки в приветствие. */
function firstName(ctx: VaryLeadContext): string {
  const raw = (ctx.displayName ?? '').trim()
  if (!raw) return ''
  const token = raw.split(/\s+/)[0]
  // Отсекаем очевидно не-именные токены (телефоны, ссылки, спецсимволы).
  if (!token || /[0-9@/\\]/.test(token)) return ''
  return token
}

/**
 * Группы приветствий одного регистра вежливости. Свап делаем ТОЛЬКО внутри
 * группы, чтобы не сменить тон (формальное на панибратское и наоборот).
 */
const GREETING_GROUPS: string[][] = [
  ['здравствуйте', 'добрый день', 'приветствую'],
  ['привет', 'здравствуй', 'добрый день'],
]

function swapGreeting(text: string, seed: number): string {
  const lower = text.toLowerCase()
  for (const group of GREETING_GROUPS) {
    for (const g of group) {
      // Приветствие должно стоять в самом начале и заканчиваться границей слова.
      if (lower.startsWith(g)) {
        const rest = text.slice(g.length)
        const pick = group[seed % group.length]
        // Сохраняем капитализацию первой буквы исходного текста.
        const capitalized =
          text[0] === text[0]?.toUpperCase()
            ? pick.charAt(0).toUpperCase() + pick.slice(1)
            : pick
        return capitalized + rest
      }
    }
  }
  return text
}

/**
 * Применить уникализацию к первому сообщению для конкретного лида.
 * Возвращает готовый к отправке текст.
 */
export function varyFirstTouch(input: string, ctx: VaryLeadContext): string {
  const seed = seedFrom(ctx.id)
  const name = firstName(ctx)

  // 1. Нормализуем пробелы (кратные пробелы/табы — тоже сигнатура шаблона).
  let text = input.replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').trim()

  // 2. Подстановка имени в плейсхолдеры. Если имени нет — убираем плейсхолдер
  //    вместе с прилегающей запятой/пробелом, чтобы не осталось "привет, !".
  const hasPlaceholder = /\{(name|имя|first|firstname)\}/i.test(text)
  if (hasPlaceholder) {
    if (name) {
      text = text.replace(/\{(name|имя|first|firstname)\}/gi, name)
    } else {
      text = text
        .replace(/,?\s*\{(name|имя|first|firstname)\}/gi, '')
        .replace(/\s{2,}/g, ' ')
        .trim()
    }
  }

  // 3. Синоним приветствия в том же регистре (детерминированно по лиду).
  text = swapGreeting(text, seed)

  // 4. Финальная пунктуация: детерминированно ставим/снимаем точку, только если
  //    сообщение заканчивается буквой (не эмодзи, не ! ? …).
  const endsWithLetter = /[a-zA-Zа-яА-ЯёЁ]$/.test(text)
  if (endsWithLetter) {
    if (seed % 2 === 0) text = text + '.'
  }

  return text.trim()
}
