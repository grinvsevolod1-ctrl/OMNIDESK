import type { ChannelType } from '@/lib/types'
import type { SimGender, SimPersona, SimStyle, SimTone } from './types'

/* ========================================================================= */
/*  Randomness helpers                                                       */
/* ========================================================================= */

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

export function chance(p: number): boolean {
  return Math.random() < p
}

export function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1))
}

/** Shuffle a copy of the array (Fisher-Yates). */
export function shuffle<T>(arr: readonly T[]): T[] {
  const out = arr.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/* ========================================================================= */
/*  Names & handles                                                          */
/* ========================================================================= */

const MALE_FIRST = [
  'Александр', 'Дмитрий', 'Сергей', 'Иван', 'Максим', 'Андрей', 'Павел',
  'Никита', 'Роман', 'Артём', 'Егор', 'Алексей', 'Михаил', 'Кирилл', 'Данила',
  'Владимир', 'Денис', 'Евгений', 'Антон', 'Илья', 'Влад', 'Виктор', 'Стас',
  'Николай', 'Костя', 'Тимур', 'Гриша', 'Матвей', 'Олег', 'Женя', 'Лёха',
]

const FEMALE_FIRST = [
  'Мария', 'Анна', 'Катя', 'Ольга', 'Наташа', 'Вика', 'Юля', 'Даша', 'Ксюша',
  'Полина', 'София', 'Лена', 'Таня', 'Ира', 'Настя', 'Алина', 'Марина', 'Лера',
  'Света', 'Вероника', 'Кристина', 'Оксана', 'Милана', 'Арина', 'Диана', 'Женя',
]

const MALE_LAST = [
  'Иванов', 'Смирнов', 'Кузнецов', 'Соколов', 'Козлов', 'Морозов', 'Петров',
  'Михайлов', 'Никитин', 'Захаров', 'Волков', 'Фёдоров', 'Егоров', 'Попов',
  'Лебедев', 'Новиков', 'Орлов', 'Павлов', 'Семёнов', 'Голубев', 'Фролов',
  'Богданов', 'Воробьёв', 'Беляев', 'Комаров', 'Киселёв', 'Макаров', 'Зайцев',
]

function femaleLast(male: string): string {
  if (male.endsWith('ий') || male.endsWith('ой')) return male.slice(0, -2) + 'ая'
  return male + 'а'
}

// Weird telegram-nick fragments — "всякая хуйня" as requested.
const NICK_WORDS = [
  'kirya', 'sanya', 'vovan', 'dimon', 'max', 'serega', 'zver', 'batya', 'boss',
  'nagibator', 'killer', 'ork', 'demon', 'shadow', 'pro', 'legenda', 'brat',
  'kot', 'pes', 'volk', 'tapok', 'pelmen', 'suslik', 'homyak', 'bomb', 'chad',
  'gopnik', 'slavik', 'toha', 'jenya', 'nikita', 'lox', 'krutoy', 'ded', 'money',
  'work', 'rabota', 'ищу', 'zarabotok', 'cash', 'fart', 'udacha', 'tven',
]

const NICK_SUFFIX = ['', '_', 'xx', 'x', '228', '777', '007', '1', '69', '13', '99', '2024', '_official', 'top', 'ru', '_msk', '_spb']

function randomNick(): string {
  const base = pick(NICK_WORDS)
  const mid = chance(0.5) ? pick(NICK_WORDS) : ''
  const num = chance(0.6) ? String(randInt(1, 9999)) : pick(NICK_SUFFIX)
  const glue = chance(0.5) ? '_' : ''
  return `${base}${glue}${mid}${num}`.replace(/__+/g, '_').slice(0, 24) || 'user' + randInt(100, 999)
}

/* ========================================================================= */
/*  Job hooks — what the "client" thinks they found on the site              */
/*  Kept as fragments so the LLM (and templates) phrase them differently     */
/*  every time and never sound copy-pasted.                                  */
/* ========================================================================= */

export const JOB_HOOKS = [
  'вакансия курьера',
  'работа на дому',
  'подработка с ежедневными выплатами',
  'вакансия оператора',
  'работа без опыта',
  'вакансия упаковщика',
  'удалённая работа',
  'работа за 5000 в день',
  'вакансия водителя',
  'подработка для студентов',
  'работа кладовщиком',
  'вакансия менеджера',
  'работа вахтой',
  'быстрый заработок',
  'вакансия сборщика заказов',
  'работа в такси',
  'подработка вечерами',
  'вакансия грузчика',
  'работа с телефона',
  'халтура на выходные',
  'подработка без вложений',
  'работа для пенсионеров',
  'вакансия сортировщика',
  'работа в интернете',
  'подработка на пару часов',
  'вакансия комплектовщика',
  'работа наборщиком текста',
  'вакансия промоутера',
  'работа расклейщиком',
  'подработка с ежедневной оплатой на карту',
  'вакансия администратора чата',
  'работа тайным покупателем',
  'вакансия по обработке заказов',
  'подработка для мам в декрете',
  'работа онлайн от 2000 в день',
  'вакансия фасовщика',
  'работа сборщиком на складе',
  'подработка вахтовым методом',
  'вакансия мерчендайзера',
  'работа курьером на своём авто',
  'вакансия оператора call-центра',
  'работа с ежедневной выплатой наличкой',
  'подработка после основной работы',
  'вакансия разнорабочего',
  'работа помощником менеджера',
  'быстрые деньги без опыта',
  'вакансия по раскладке товара',
  'работа удалённо с телефона',
  'подработка на вечер и ночь',
  'вакансия оператора склада',
  'работа для подростков 16 лет',
  'заработок в свободное время',
]

/* ========================================================================= */
/*  Persona factory                                                          */
/* ========================================================================= */

const TEMPERS = [
  'спокойный', 'нетерпеливый', 'подозрительный', 'наглый', 'вспыльчивый',
  'дружелюбный', 'уставший', 'нервный', 'деловой', 'простоватый', 'дерзкий',
  'ноющий', 'жадный до денег', 'осторожный', 'борзый', 'туповатый',
  'весёлый', 'занудный', 'недоверчивый', 'торопливый', 'сонный', 'въедливый',
  'скептик', 'наивный', 'циничный', 'дотошный', 'раздражённый', 'добродушный',
  'хамоватый', 'меркантильный', 'мнительный', 'разговорчивый', 'молчаливый',
  'обидчивый', 'ленивый', 'дерзкий на язык', 'придирчивый', 'простодушный',
  'настороженный', 'прожжённый', 'отчаявшийся', 'азартный', 'прижимистый',
]

function rollStyle(aggression: number, tone: SimTone): SimStyle {
  // aggression 0..100 raises profanity + terseness baselines.
  const a = Math.max(0, Math.min(100, aggression)) / 100

  switch (tone) {
    case 'polite':
      // Grammatical, capitalised, punctuated, no swearing.
      return {
        lowercase: false,
        noPunctuation: false,
        typoRate: Math.min(0.06, 0.01 + Math.random() * 0.05),
        profanity: 0,
        terseness: 0.2 + Math.random() * 0.3,
        dumbness: Math.random() * 0.3,
        emojiRate: chance(0.3) ? Math.random() * 0.15 : 0,
      }
    case 'neutral':
      // Everyday conversational: a little sloppy, but never rude.
      return {
        lowercase: chance(0.4),
        noPunctuation: chance(0.4),
        typoRate: Math.min(0.15, 0.03 + Math.random() * 0.12),
        profanity: Math.min(0.15, a * 0.15),
        terseness: 0.3 + Math.random() * 0.4,
        dumbness: Math.random() * 0.5,
        emojiRate: chance(0.45) ? Math.random() * 0.25 : 0,
      }
    case 'rough':
      // Slangy/panibratski, punctuation-light, swears scale with aggression.
      return {
        lowercase: chance(0.85),
        noPunctuation: chance(0.85),
        typoRate: Math.min(0.35, 0.08 + Math.random() * 0.27),
        profanity: Math.min(1, Math.max(0.15, a * (0.5 + Math.random() * 0.9))),
        terseness: Math.min(1, 0.4 + a * 0.4 + Math.random() * 0.3),
        dumbness: Math.random() * 0.7,
        emojiRate: chance(0.5) ? Math.random() * 0.3 : 0,
      }
    default:
      // 'mixed' — the original wide random spread.
      return {
        lowercase: chance(0.7),
        noPunctuation: chance(0.75),
        typoRate: Math.min(0.35, 0.05 + Math.random() * 0.28),
        profanity: Math.min(1, Math.max(0, a * (0.4 + Math.random() * 0.9))),
        terseness: Math.min(1, 0.3 + a * 0.4 + Math.random() * 0.4),
        dumbness: Math.random() * 0.7,
        emojiRate: chance(0.5) ? Math.random() * 0.3 : 0,
      }
  }
}

/**
 * Build a channel-appropriate fake client. Telegram leans on weird @nicks,
 * WhatsApp on phone-number handles, VK/MAX on id-style handles + real names.
 */
export function makePersona(
  channelType: ChannelType,
  aggression: number,
  tone: SimTone = 'mixed',
): SimPersona {
  const gender: SimGender = chance(0.55) ? 'male' : 'female'
  const first = pick(gender === 'male' ? MALE_FIRST : FEMALE_FIRST)
  const baseLast = pick(MALE_LAST)
  const last = gender === 'male' ? baseLast : femaleLast(baseLast)

  let name: string
  let handle: string
  let username: string | undefined

  switch (channelType) {
    case 'telegram': {
      // Often a weird nick as the display name, sometimes a real first name.
      username = randomNick()
      name = chance(0.45) ? first : chance(0.5) ? `${first} ${last}` : username
      handle = `@${username}`
      break
    }
    case 'whatsapp': {
      name = chance(0.7) ? first : `${first} ${last}`
      handle = `+7${randInt(900, 999)}${String(randInt(1000000, 9999999))}`
      break
    }
    case 'vk': {
      name = `${first} ${last}`
      username = chance(0.5) ? randomNick() : `id${randInt(1000000, 899999999)}`
      handle = `id${randInt(1000000, 899999999)}`
      break
    }
    case 'max': {
      name = first
      handle = `id${randInt(100000, 900000000)}`
      break
    }
    default: {
      // livechat / anything else — anonymous site visitor
      name = chance(0.5) ? first : `Гость ${randInt(100, 999)}`
      handle = `visitor-${randInt(100000, 999999)}`
    }
  }

  return {
    name,
    handle,
    username,
    gender,
    channelType,
    age: randInt(17, 52),
    temper: pick(TEMPERS),
    jobHook: pick(JOB_HOOKS),
    tone,
    style: rollStyle(aggression, tone),
  }
}

/* ========================================================================= */
/*  Human-noise style mangling                                               */
/*  Applied on top of BOTH the LLM output and the templates so every line    */
/*  looks hand-typed: lowercase, dropped punctuation, believable typos.      */
/* ========================================================================= */

const TYPO_ADJACENT: Record<string, string> = {
  о: 'ао', а: 'оя', е: 'еёи', и: 'ий', н: 'нг', т: 'ть', с: 'сщ', в: 'ва',
  р: 'рп', л: 'лд', к: 'ку', м: 'мн', п: 'по', д: 'дл',
}

function typoWord(word: string): string {
  if (word.length < 3) return word
  const roll = Math.random()
  const i = randInt(0, word.length - 1)
  if (roll < 0.3 && i < word.length - 1) {
    // swap two adjacent chars
    const arr = word.split('')
    ;[arr[i], arr[i + 1]] = [arr[i + 1], arr[i]]
    return arr.join('')
  }
  if (roll < 0.55) {
    // drop a char
    return word.slice(0, i) + word.slice(i + 1)
  }
  if (roll < 0.78) {
    // double a char
    return word.slice(0, i) + word[i] + word.slice(i)
  }
  // wrong neighbour key
  const lower = word[i].toLowerCase()
  const near = TYPO_ADJACENT[lower]
  if (near) {
    const rep = near[randInt(0, near.length - 1)]
    return word.slice(0, i) + rep + word.slice(i + 1)
  }
  return word
}

const EMOJIS = [
  '))', ')))', '))))', '))))))', '(', '((', ')', '))))))))',
  '🙂', '👍', '😂', '🤝', '💰', '🔥', '😏', '🤔', '😄', '🙃', '😅', '👀',
  '🤷', '😉', '💵', '✌️', '🫡', '😐', '🥱', '😤', '🤨', '😬', '👌', '💪',
]

/** Apply a persona's writing fingerprint to a clean sentence. */
export function applyStyle(text: string, style: SimStyle): string {
  let out = text.trim()
  if (!out) return out

  // typos, word by word
  if (style.typoRate > 0) {
    out = out
      .split(/(\s+)/)
      .map((tok) => (/\s/.test(tok) || chance(1 - style.typoRate) ? tok : typoWord(tok)))
      .join('')
  }

  if (style.noPunctuation) {
    // drop most sentence punctuation; keep the odd question mark sometimes
    out = out.replace(/[.,;:!]+/g, '')
    if (chance(0.6)) out = out.replace(/\?+/g, '')
    out = out.replace(/\s+/g, ' ').trim()
  }

  if (style.lowercase) out = out.toLowerCase()

  if (style.emojiRate > 0 && chance(style.emojiRate)) {
    out = out + (chance(0.5) ? ' ' : '') + pick(EMOJIS)
  }

  return out.slice(0, 500)
}

/* ========================================================================= */
/*  Template fallback pools                                                  */
/*  Used only when the LLM is unavailable. Composed + mangled so even the    */
/*  fallback varies wildly and rarely repeats.                               */
/* ========================================================================= */

const OPENERS = [
  'здравствуйте нашёл у вас {hook} ещё актуально',
  'привет по поводу {hook} можно узнать',
  'добрый день интересует {hook} что нужно делать',
  'здрасте я по {hook} как устроиться',
  'здравствуйте увидел объявление {hook} расскажите',
  'это по работе {hook} ещё есть места',
  'привет а {hook} реальная или развод',
  'здравствуйте хочу работать у вас видел {hook}',
  'мне сказали тут {hook} есть это правда',
  'добрый по поводу подработки писал бот сказал сюда',
  'здарова {hook} ещё в силе или уже закрыли',
  'здравствуйте а сколько платите за {hook}',
  'доброго дня наткнулся на {hook} хочу подробнее',
  'привет увидел {hook} в вк это к вам',
  'здрасьте по {hook} можно пару вопросов',
  'здравствуйте мне подруга скинула {hook} расскажете',
  'добрый вечер {hook} ещё набираете людей',
  'здарова видел {hook} на авито это тут',
  'привет а по {hook} что за условия',
  'здравствуйте пишу по объявлению {hook}',
  'доброе утро интересует {hook} с чего начать',
  'здрасте нашёл {hook} в телеге куда обращаться',
  'привет это правда что по {hook} платят каждый день',
  'здравствуйте хотел бы попробовать {hook}',
  'добрый а {hook} для новичка подойдёт',
  'здарова короче видел {hook} чё по чём',
  'здравствуйте можно узнать про {hook} поподробнее',
  'привет а {hook} без опыта берёте',
  'здрасьте я по поводу {hook} ещё актуально или нет',
  'добрый день откликаюсь на {hook}',
]

const CURIOUS = [
  'а что по деньгам',
  'и сколько платить будете',
  'а что конкретно делать надо',
  'опыт нужен или без разницы',
  'а когда можно начать',
  'график какой',
  'а официально или как',
  'что за работа то расскажите нормально',
  'выплаты каждый день да',
  'а где находится',
  'а это точно не кидалово',
  'скинте подробности',
  'а сколько в день выходит примерно',
  'платите на карту или как',
  'а возраст важен',
  'сколько часов в день пахать',
  'а обучение есть или сразу в бой',
  'аванс дадите или потом',
  'а что за компания вообще',
  'договор будет',
  'а можно совмещать с основной',
  'сколько людей уже у вас работает',
  'а первые деньги когда получу',
  'нужно что то покупать за свой счёт',
  'а какие вложения нужны',
  'удалённо можно или только офис',
  'а справки какие нужны',
  'что по итогу от меня требуется то',
  'а если не получится что будет',
  'реально ли столько заработать',
  'а можно с телефона всё делать',
  'скинь ссылку или инструкцию',
  'а вы точно платите людям',
  'сколько на руки в неделю выходит',
  'а испытательный есть',
]

const ANGRY = [
  'вы чё за развод устроили',
  'это что за хрень вообще',
  'ты меня за дурака держишь',
  'какая нахрен предоплата совсем офигели',
  'это же незаконно вы норм вообще',
  'иди ты со своей работой знаешь куда',
  'да пошли вы нахер с такой работой',
  'че за дичь ты мне пишешь',
  'я в полицию щас напишу на вас',
  'вы мошенники обычные',
  'сам иди работай на такой работе',
  'ахах ну и наглые же вы',
  'какие деньги вперёд ты офигел',
  'развод чистой воды тьфу',
  'за лоха меня приняли да',
  'вы совсем страх потеряли',
  'это статья вообще то знаешь',
  'да таких как ты сажать надо',
  'не смеши мои тапки какая работа',
  'скамеры чёртовы отвалите',
  'ты сначала заплати потом проси',
  'че за наглость вообще охренели',
  'я щас вас по всем чатам разнесу',
  'мутотень какая то а не работа',
  'заманали уже такие вакансии',
  'вы серьёзно людей так разводите',
  'да иди лесом со своей схемой',
  'ну вы и жулики конечно',
  'катись со своими картами куда подальше',
  'думаешь самый умный да',
]

const DISMISSIVE = [
  'не не мне такое не надо',
  'спасибо не интересует',
  'нее это не моё',
  'подумаю потом напишу',
  'да ну нафиг',
  'не буду я этим заниматься',
  'ищите другого дурака',
  'мутно как то всё',
  'не мой вариант извините',
  'да ладно проехали',
  'что то не хочется',
  'передумал спасибо',
  'нее слишком стрёмно',
  'подыщу что нибудь другое',
  'не убедили честно',
  'как нибудь без меня',
  'не горит мне это',
  'да забей не надо',
  'нее не по мне такое',
  'ну такое себе если честно',
  'спасибо но пас',
  'что то не вдохновляет',
  'да ну эти схемы',
  'лучше на завод пойду',
  'неа не заинтересовало',
]

const CONFUSED = [
  'а это как вообще',
  'не понял чё делать то',
  'подождите я запутался',
  'а можно попроще объяснить',
  'эмм в смысле',
  'то есть как это',
  'а зачем мне это',
  'какие карты причём тут карты',
  'погоди чё за схема',
  'не догоняю если честно',
  'а можно на пальцах',
  'что за приложение качать зачем',
  'а куда деньги то придут',
  'я не понял про оплату повтори',
  'это типа как работает',
  'а зачем мои данные',
  'чёт сложно можно ещё раз',
  'не втыкаю совсем',
  'а это вообще законно так делать',
  'подожди какой перевод куда',
  'ничего не понял можно ссылку',
  'а если у меня карты нет тогда как',
  'че за коды какие коды',
  'так стоп с начала можно',
  'а я то тут при чём',
]

const FILLERS = [
  'ало', 'вы тут', 'ну что там', 'че молчите', 'долго ещё ждать', 'эй',
  'есть кто', 'жду ответ', 'ну', 'и', 'а дальше', 'че как', 'ау',
  'вы онлайн', 'ответьте плиз', 'куда пропали', 'ну чё там по работе',
  'я ещё жду вообще то', 'долго думать будете', 'алё есть кто живой',
  'ну так что', 'молчание в ответ ясно', 'э я тут вообще то', 'так и будем молчать',
  'ответишь или нет', 'ну давай уже', 'сколько можно ждать', 'че затих',
]

function fill(template: string, persona: SimPersona): string {
  return template.replace('{hook}', persona.jobHook)
}

export type TemplateKind = 'opener' | 'curious' | 'angry' | 'dismissive' | 'confused' | 'filler'

// Small conversational lead-ins stapled to the front of a line now and then,
// so even repeated core phrases start differently ("ну", "слушай", "эй" ...).
const PREFIXES = [
  'ну', 'слушай', 'эй', 'блин', 'кароч', 'так', 'слушайте', 'э', 'ладно',
  'ок', 'хм', 'ну это', 'вот', 'смотри', 'да и', 'а', 'ну а', 'стоп',
]

// Trailing tics some people tack on.
const SUFFIXES = [
  'если чё', 'вообще', 'честно', 'или как', 'да', 'нет', 'а то', 'блин',
  'сори', 'если что', 'просто', 'ну такое', 'вот так вот',
]

export function templateLine(kind: TemplateKind, persona: SimPersona): string {
  let pool: readonly string[]
  switch (kind) {
    case 'opener': pool = OPENERS; break
    case 'curious': pool = CURIOUS; break
    case 'angry': pool = ANGRY; break
    case 'dismissive': pool = DISMISSIVE; break
    case 'confused': pool = CONFUSED; break
    default: pool = FILLERS
  }

  let line = fill(pick(pool), persona)

  // Staple a second fragment on non-openers for variety — pick from a related
  // pool so it still reads coherently.
  if (kind !== 'opener' && chance(0.3)) {
    const secondPool =
      kind === 'angry'
        ? ANGRY
        : kind === 'confused'
          ? CONFUSED
          : kind === 'dismissive'
            ? DISMISSIVE
            : CURIOUS
    const second = fill(pick(secondPool), persona)
    if (normLoose(second) !== normLoose(line)) line = `${line} ${second}`
  }

  // Optional lead-in prefix (not on openers — they already greet).
  if (kind !== 'opener' && chance(0.3)) {
    line = `${pick(PREFIXES)} ${line}`
  }

  // Optional trailing tic.
  if (chance(0.2)) {
    line = `${line} ${pick(SUFFIXES)}`
  }

  return applyStyle(line, persona.style)
}

/** Loose normaliser used to avoid stapling two identical fragments together. */
function normLoose(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim()
}
