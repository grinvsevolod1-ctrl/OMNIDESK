/**
 * Deterministic generator of 1000 unique candidate dialog scenarios for the
 * god messenger ("Сценарии" tab of the new-chat dialog).
 *
 * Each scenario is a ready-to-send opening message in the style of
 * "Здравствуйте! Я прошёл ИИ-подбор на сайте Thunders Group…" plus a dialog
 * context card telling the operator HOW this "candidate" will behave in the
 * conversation that follows (tone, concerns, expected outcome).
 *
 * Design notes:
 *  - Uniqueness is GUARANTEED structurally: scenario i uses name[i % 50] and
 *    vacancy[floor(i / 50)] — 50 × 20 = exactly 1000 distinct (person, job)
 *    pairs, so no two intros can ever be identical.
 *  - All other variety (greeting, phrasing, age, match %, concerns, tone) is
 *    drawn from a PRNG seeded with the scenario index, so the full list is
 *    stable across renders, reloads and server/client — scenario #317 is
 *    always the same dialog.
 *  - Pure module: no React, no server deps. Generated lazily and memoised.
 */

export interface DialogScenario {
  /** Stable 0-based index (shown as №N in the picker). */
  id: number
  contactName: string
  /** Plausible messenger handle, unique per scenario. */
  contactHandle: string
  age: number
  vacancyTitle: string
  city: string
  salary: string
  schedule: string
  /** AI-match percentage, 76–97. */
  match: number
  /** The opening message sent "as the client". */
  intro: string
  /** Operator-facing context: persona + how the dialog will develop. */
  context: string
}

/* ------------------------------ PRNG (seeded) ----------------------------- */

/** mulberry32 — tiny deterministic PRNG, good enough for content variety. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const pick = <T,>(rnd: () => number, arr: readonly T[]): T =>
  arr[Math.floor(rnd() * arr.length)]

const int = (rnd: () => number, min: number, max: number): number =>
  min + Math.floor(rnd() * (max - min + 1))

/* ------------------------------ Source data ------------------------------- */

/** 50 names; `f` = female (controls прошёл/прошла, заполнил/заполнила…). */
const NAMES: ReadonlyArray<{ n: string; f: boolean }> = [
  { n: 'Иван Петров', f: false },
  { n: 'Алексей Смирнов', f: false },
  { n: 'Дмитрий Кузнецов', f: false },
  { n: 'Сергей Попов', f: false },
  { n: 'Андрей Васильев', f: false },
  { n: 'Максим Соколов', f: false },
  { n: 'Николай Михайлов', f: false },
  { n: 'Артём Новиков', f: false },
  { n: 'Владимир Фёдоров', f: false },
  { n: 'Егор Морозов', f: false },
  { n: 'Павел Волков', f: false },
  { n: 'Роман Алексеев', f: false },
  { n: 'Кирилл Лебедев', f: false },
  { n: 'Денис Семёнов', f: false },
  { n: 'Олег Егоров', f: false },
  { n: 'Виктор Павлов', f: false },
  { n: 'Игорь Козлов', f: false },
  { n: 'Станислав Степанов', f: false },
  { n: 'Тимур Николаев', f: false },
  { n: 'Руслан Орлов', f: false },
  { n: 'Марат Андреев', f: false },
  { n: 'Григорий Макаров', f: false },
  { n: 'Антон Никитин', f: false },
  { n: 'Вадим Захаров', f: false },
  { n: 'Юрий Зайцев', f: false },
  { n: 'Анна Соловьёва', f: true },
  { n: 'Мария Борисова', f: true },
  { n: 'Елена Яковлева', f: true },
  { n: 'Ольга Григорьева', f: true },
  { n: 'Наталья Романова', f: true },
  { n: 'Татьяна Воробьёва', f: true },
  { n: 'Ирина Сергеева', f: true },
  { n: 'Светлана Кузьмина', f: true },
  { n: 'Екатерина Фролова', f: true },
  { n: 'Юлия Александрова', f: true },
  { n: 'Дарья Дмитриева', f: true },
  { n: 'Алина Королёва', f: true },
  { n: 'Ксения Гусева', f: true },
  { n: 'Виктория Киселёва', f: true },
  { n: 'Полина Ильина', f: true },
  { n: 'Валерия Максимова', f: true },
  { n: 'Надежда Осипова', f: true },
  { n: 'Оксана Андрианова', f: true },
  { n: 'Марина Тихонова', f: true },
  { n: 'Вера Белова', f: true },
  { n: 'Людмила Комарова', f: true },
  { n: 'Галина Щербакова', f: true },
  { n: 'Алёна Мельникова', f: true },
  { n: 'Евгения Крылова', f: true },
  { n: 'София Карпова', f: true },
]

/** 20 vacancies: title, city, salary floor (₽/мес), schedule. */
const VACANCIES: ReadonlyArray<{
  t: string
  c: string
  s: number
  g: string
}> = [
  { t: 'Кладовщик-комплектовщик', c: 'Екатеринбург', s: 75_000, g: 'Сменный график' },
  { t: 'Комплектовщик заказов', c: 'Москва', s: 95_000, g: 'Вахта 30/15' },
  { t: 'Упаковщик на склад', c: 'Санкт-Петербург', s: 82_000, g: 'График 2/2' },
  { t: 'Грузчик-разнорабочий', c: 'Казань', s: 68_000, g: 'График 5/2' },
  { t: 'Оператор склада (ТСД)', c: 'Новосибирск', s: 78_000, g: 'Сменный график' },
  { t: 'Сборщик заказов маркетплейса', c: 'Подольск', s: 92_000, g: 'Вахта 45/15' },
  { t: 'Водитель погрузчика', c: 'Нижний Новгород', s: 88_000, g: 'График 2/2' },
  { t: 'Сортировщик на конвейер', c: 'Ростов-на-Дону', s: 71_000, g: 'Сменный график' },
  { t: 'Работник производственной линии', c: 'Челябинск', s: 74_000, g: 'График 3/3' },
  { t: 'Фасовщик продукции', c: 'Самара', s: 66_000, g: 'График 5/2' },
  { t: 'Приёмщик товара', c: 'Краснодар', s: 72_000, g: 'График 2/2' },
  { t: 'Оператор производственной линии', c: 'Уфа', s: 80_000, g: 'Сменный график' },
  { t: 'Маркировщик на склад', c: 'Тюмень', s: 69_000, g: 'График 6/1' },
  { t: 'Кладовщик (холодный склад)', c: 'Пермь', s: 85_000, g: 'Вахта 60/30' },
  { t: 'Комплектовщик (ночные смены)', c: 'Воронеж', s: 90_000, g: 'Ночные смены' },
  { t: 'Разнорабочий на производство', c: 'Красноярск', s: 76_000, g: 'Вахта 30/15' },
  { t: 'Стикеровщик товара', c: 'Химки', s: 83_000, g: 'График 2/2' },
  { t: 'Оператор упаковочной машины', c: 'Омск', s: 73_000, g: 'Сменный график' },
  { t: 'Сборщик мебели на производстве', c: 'Волгоград', s: 79_000, g: 'График 5/2' },
  { t: 'Кладовщик-учётчик', c: 'Иркутск', s: 81_000, g: 'Вахта 45/15' },
]

const GREETINGS = [
  'Здравствуйте!',
  'Добрый день!',
  'Добрый вечер!',
  'Доброе утро!',
  'Здравствуйте.',
  'Привет!',
  'Доброго времени суток!',
] as const

/**
 * Opening phrasings. `{v}` — gender verb prefix pair index:
 * templates receive already-conjugated verbs via the `v()` helper.
 */
const SOURCE_PHRASES = [
  (v: (m: string, f: string) => string) =>
    `Я ${v('прошёл', 'прошла')} ИИ-подбор на сайте Thunders Group.`,
  (v: (m: string, f: string) => string) =>
    `Я ${v('заполнил', 'заполнила')} анкету ИИ-подбора на сайте Thunders Group.`,
  (v: (m: string, f: string) => string) =>
    `Только что ${v('прошёл', 'прошла')} подбор через ИИ на сайте Thunders Group.`,
  // «ИИ подобрал» — подлежащее «ИИ», склонение по полу кандидата не требуется.
  (_v: (m: string, f: string) => string) =>
    `Мне на сайте Thunders Group ИИ подобрал вакансию.`,
  (v: (m: string, f: string) => string) =>
    `Я ${v('прошёл', 'прошла')} онлайн-подбор вакансии у Thunders Group.`,
  (v: (m: string, f: string) => string) =>
    `Пишу с сайта Thunders Group — ${v('прошёл', 'прошла')} там ИИ-подбор.`,
] as const

const MATCH_PHRASES = [
  (m: number) => `Совпадение — ${m}%.`,
  (m: number) => `Система показала совпадение ${m}%.`,
  (m: number) => `Точность подбора — ${m}%.`,
  (m: number) => `ИИ оценил совпадение в ${m}%.`,
  (m: number) => `Процент совпадения: ${m}%.`,
] as const

const CLOSING_QUESTIONS = [
  'Подскажите, пожалуйста, детали — вакансия ещё актуальна?',
  'Скажите, вакансия ещё открыта? Хочу узнать подробности.',
  'Хотелось бы узнать детали. Место ещё свободно?',
  'Можно узнать подробнее об условиях? Вакансия актуальна?',
  'Расскажите, пожалуйста, подробнее. Ещё набираете людей?',
  'Актуально ли ещё предложение? И что нужно для оформления?',
  'Напишите, пожалуйста, детали — когда можно приступить?',
  'Вакансия ещё в силе? Готов(а) обсудить условия.',
] as const

/* --------------------------- Context building ----------------------------- */

const TONES = [
  'вежливый и обстоятельный',
  'торопится, отвечает коротко',
  'недоверчивый, переспрашивает условия',
  'дотошный, просит всё зафиксировать письменно',
  'дружелюбный, много благодарит',
  'сомневается, сравнивает с другим предложением',
  'решительный, готов выйти сразу',
  'осторожный, сначала спросит про договор',
] as const

const CONCERNS = [
  'частота и способ выплат (аванс, карта)',
  'оформление по ТК или подряд',
  'предоставляется ли общежитие/проживание',
  'оплачивается ли дорога до объекта',
  'точный адрес и как добираться',
  'нужна ли спецодежда и за чей счёт',
  'обязателен ли опыт работы',
  'есть ли подработки/переработки и как оплачиваются',
  'возможен ли сдвиг даты выхода',
  'график смен и продолжительность смены',
  'есть ли медосмотр и кто его оплачивает',
  'питание на объекте',
] as const

const OUTCOMES = [
  'в итоге соглашается на собеседование и просит прислать адрес',
  'просит перезвонить после 18:00 для обсуждения деталей',
  'берёт паузу до завтра, но просит закрепить вакансию',
  'соглашается выйти на стажировочную смену на этой неделе',
  'просит отправить список документов для оформления',
  'уточняет всё и обещает дать ответ в течение дня',
  'договаривается о звонке с менеджером на завтра',
  'соглашается и спрашивает, можно ли привести знакомого',
] as const

/* ------------------------------- Generator -------------------------------- */

function buildScenario(i: number): DialogScenario {
  const rnd = mulberry32(0x9e3779b9 ^ (i * 2654435761))

  // Structural uniqueness: 50 names × 20 vacancies = 1000 distinct pairs.
  const person = NAMES[i % NAMES.length]
  const vacancy = VACANCIES[Math.floor(i / NAMES.length) % VACANCIES.length]

  const v = (m: string, f: string) => (person.f ? f : m)
  const age = int(rnd, 18, 52)
  const match = int(rnd, 76, 97)
  const salary = `от ${vacancy.s.toLocaleString('ru-RU')} ₽`

  const agePhrase = pick(rnd, [
    `Мне ${age} ${ageWord(age)}.`,
    `Мне ${age}.`,
    `Возраст — ${age} ${ageWord(age)}.`,
  ] as const)

  const vacancyPhrase = pick(rnd, [
    `Для меня подобрали вакансию: «${vacancy.t}» (${vacancy.c}, ${salary}, ${vacancy.g}).`,
    `Мне предложили вакансию «${vacancy.t}» — ${vacancy.c}, ${salary}, ${vacancy.g}.`,
    `Подобранная вакансия: «${vacancy.t}», город ${vacancy.c}, ${salary}, ${vacancy.g}.`,
    `Система подобрала мне «${vacancy.t}» (${vacancy.c}), ${salary}, ${vacancy.g}.`,
  ] as const)

  const intro = [
    pick(rnd, GREETINGS),
    pick(rnd, SOURCE_PHRASES)(v),
    agePhrase,
    vacancyPhrase,
    pick(rnd, MATCH_PHRASES)(match),
    pick(rnd, CLOSING_QUESTIONS),
  ].join(' ')

  // Two distinct concerns per persona.
  const c1 = int(rnd, 0, CONCERNS.length - 1)
  let c2 = int(rnd, 0, CONCERNS.length - 2)
  if (c2 >= c1) c2 += 1

  const context =
    `Кандидат: ${person.n}, ${age} ${ageWord(age)}, откликается на «${vacancy.t}» ` +
    `(${vacancy.c}, ${salary}, ${vacancy.g}), совпадение ${match}%. ` +
    `Тон: ${pick(rnd, TONES)}. ` +
    `По ходу диалога спросит: ${CONCERNS[c1]}; затем — ${CONCERNS[c2]}. ` +
    `Итог: ${pick(rnd, OUTCOMES)}.`

  return {
    id: i,
    contactName: person.n,
    contactHandle: `id${String(100_000_000 + Math.floor(rnd() * 900_000_000))}`,
    age,
    vacancyTitle: vacancy.t,
    city: vacancy.c,
    salary,
    schedule: vacancy.g,
    match,
    intro,
    context,
  }
}

/** Correct Russian declension for "N лет/года/год". */
function ageWord(age: number): string {
  const d10 = age % 10
  const d100 = age % 100
  if (d100 >= 11 && d100 <= 14) return 'лет'
  if (d10 === 1) return 'год'
  if (d10 >= 2 && d10 <= 4) return 'года'
  return 'лет'
}

export const SCENARIO_COUNT = 1000

let cache: DialogScenario[] | null = null

/** All 1000 scenarios (generated once per session, ~stable ordering). */
export function getDialogScenarios(): DialogScenario[] {
  if (!cache) {
    cache = Array.from({ length: SCENARIO_COUNT }, (_, i) => buildScenario(i))
  }
  return cache
}
