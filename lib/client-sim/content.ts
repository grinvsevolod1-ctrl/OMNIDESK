import type { ChannelType } from '@/lib/types'
import type {
  SimArchetype,
  SimBackstory,
  SimGender,
  SimPersona,
  SimStyle,
  SimTone,
} from './types'

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
  'Григорий', 'Валерий', 'Борис', 'Геннадий', 'Юрий', 'Анатолий', 'Вадим',
  'Руслан', 'Тарас', 'Богдан', 'Захар', 'Марк', 'Тимофей', 'Ярослав', 'Глеб',
  'Родион', 'Савелий', 'Пётр', 'Фёдор', 'Семён', 'Вячеслав', 'Эдуард', 'Артур',
  'Ринат', 'Марат', 'Дамир', 'Ислам', 'Арсен', 'Гоша', 'Санёк', 'Витёк',
  'Толян', 'Колян', 'Серый', 'Димон', 'Саня', 'Вован', 'Валера', 'Слава',
  'Леонид', 'Аркадий', 'Станислав', 'Виталий', 'Альберт', 'Игорь', 'Лев',
  'Мирон', 'Демид', 'Платон', 'Даниил', 'Всеволод', 'Макар', 'Назар', 'Елисей',
  'Аслан', 'Магомед', 'Эмиль', 'Тимирлан', 'Рамиль', 'Ильдар', 'Айрат', 'Роберт',
  'Гурам', 'Ашот', 'Давид', 'Георгий', 'Спартак', 'Ефим', 'Влас', 'Прохор',
  'Жора', 'Пашок', 'Лёня', 'Ромыч', 'Андрюха', 'Мишаня', 'Витя', 'Генка',
  'Костян', 'Тёма', 'Егорка', 'Ванёк', 'Максон', 'Славик', 'Дэн', 'Рома',
]

const FEMALE_FIRST = [
  'Мария', 'Анна', 'Катя', 'Ольга', 'Наташа', 'Вика', 'Юля', 'Даша', 'Ксюша',
  'Полина', 'София', 'Лена', 'Таня', 'Ира', 'Настя', 'Алина', 'Марина', 'Лера',
  'Света', 'Вероника', 'Кристина', 'Оксана', 'Милана', 'Арина', 'Диана', 'Женя',
  'Елена', 'Татьяна', 'Людмила', 'Галина', 'Нина', 'Валентина', 'Надежда',
  'Любовь', 'Тамара', 'Раиса', 'Зоя', 'Лидия', 'Инна', 'Жанна', 'Алла',
  'Регина', 'Элина', 'Карина', 'Виктория', 'Ангелина', 'Яна', 'Снежана',
  'Гуля', 'Земфира', 'Алсу', 'Динара', 'Аделя', 'Люда', 'Валя', 'Галя',
  'Люся', 'Зина', 'Тоня', 'Маша', 'Аня', 'Оля', 'Наташка', 'Ленка', 'Танюха',
  'Екатерина', 'Дарья', 'Анастасия', 'Ксения', 'Валерия', 'Вера', 'Варвара',
  'Ева', 'Есения', 'Кира', 'Маргарита', 'Алёна', 'Юлия', 'Дина', 'Лада',
  'Нонна', 'Клавдия', 'Антонина', 'Евгения', 'Прасковья', 'Февронья', 'Ульяна',
  'Мадина', 'Лейла', 'Амина', 'Сабина', 'Румия', 'Гульнара', 'Эльвира', 'Асель',
  'Катюха', 'Дашка', 'Настюха', 'Викуся', 'Ксюха', 'Ленусик', 'Иринка', 'Юлька',
  'Танька', 'Машка', 'Светка', 'Ритка', 'Алинка', 'Настёна', 'Дашуля', 'Оксанка',
]

const MALE_LAST = [
  'Иванов', 'Смирнов', 'Кузнецов', 'Соколов', 'Козлов', 'Морозов', 'Петров',
  'Михайлов', 'Никитин', 'Захаров', 'Волков', 'Фёдоров', 'Егоров', 'Попов',
  'Лебедев', 'Новиков', 'Орлов', 'Павлов', 'Семёнов', 'Голубев', 'Фролов',
  'Богданов', 'Воробьёв', 'Беляев', 'Комаров', 'Киселёв', 'Макаров', 'Зайцев',
  'Соловьёв', 'Борисов', 'Яковлев', 'Григорьев', 'Романов', 'Воронцов',
  'Кудрявцев', 'Баранов', 'Тарасов', 'Белов', 'Гаврилов', 'Ефимов', 'Тихонов',
  'Дмитриев', 'Калинин', 'Анисимов', 'Сорокин', 'Гусев', 'Титов', 'Кузьмин',
  'Кулаков', 'Герасимов', 'Пономарёв', 'Гришин', 'Лазарев', 'Медведев',
  'Ершов', 'Никонов', 'Мельников', 'Щербаков', 'Блинов', 'Колесников',
  'Крылов', 'Максимов', 'Сидоров', 'Осипов', 'Матвеев', 'Ковалёв', 'Кириллов',
  'Абрамов', 'Степанов', 'Николаев', 'Тимофеев', 'Фомин', 'Гончаров', 'Панов',
  'Данилов', 'Носов', 'Емельянов', 'Исаев', 'Логинов', 'Филиппов', 'Соболев',
  'Мартынов', 'Капустин', 'Рябов', 'Долгов', 'Прохоров', 'Шестаков', 'Одинцов',
  'Хабибуллин', 'Гарипов', 'Насыров', 'Ахметов', 'Сафин', 'Валиев', 'Юсупов',
]

function femaleLast(male: string): string {
  if (male.endsWith('ий') || male.endsWith('ой')) return male.slice(0, -2) + 'ая'
  return male + 'а'
}

/**
 * Best-effort guess of a persona's gender from a display name, so an adopted
 * dialog's persona never contradicts the name it's pinned to (e.g. «Наталья»
 * must be female). Checks the known first-name lists first, then falls back to
 * typical Russian first-name endings. Returns null when undecidable (e.g. a
 * bare @nick) so the caller can keep the randomly-rolled gender.
 */
export function inferGenderFromName(name: string | null | undefined): SimGender | null {
  if (!name) return null
  const first = name.trim().split(/\s+/)[0]?.toLowerCase()
  if (!first) return null
  if (FEMALE_FIRST.some((n) => n.toLowerCase() === first)) return 'female'
  if (MALE_FIRST.some((n) => n.toLowerCase() === first)) return 'male'
  // Ending heuristics: most female RU first names end in -а/-я (Наталья, Ольга),
  // most male ones in a consonant/-й (Сергей, Иван). Not perfect (Никита, Илья)
  // but the known-name lists above catch the common exceptions.
  if (/(а|я)$/.test(first)) return 'female'
  if (/[бвгджзйклмнпрстфхцчшщ]$/.test(first)) return 'male'
  return null
}

// Weird telegram-nick fragments — "всякая хуйня" as requested.
const NICK_WORDS = [
  'kirya', 'sanya', 'vovan', 'dimon', 'max', 'serega', 'zver', 'batya', 'boss',
  'nagibator', 'killer', 'ork', 'demon', 'shadow', 'pro', 'legenda', 'brat',
  'kot', 'pes', 'volk', 'tapok', 'pelmen', 'suslik', 'homyak', 'bomb', 'chad',
  'gopnik', 'slavik', 'toha', 'jenya', 'nikita', 'lox', 'krutoy', 'ded', 'money',
  'work', 'rabota', 'ищу', 'zarabotok', 'cash', 'fart', 'udacha', 'tven',
  'mister', 'user', 'gamer', 'sniper', 'wolf', 'tiger', 'phoenix', 'ghost',
  'dark', 'black', 'red', 'ice', 'fire', 'storm', 'god', 'lord', 'king',
  'baron', 'joker', 'punk', 'rebel', 'free', 'lucky', 'dengi', 'bablo',
  'hunter', 'drift', 'turbo', 'nitro', 'vape', 'chill', 'vibe', 'mood',
  'anon', 'noname', 'random', 'privet', 'poka', 'davay', 'norm', 'ok',
  'kotik', 'mishka', 'zaya', 'solnce', 'angel', 'princess', 'malish', 'bro',
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
  'вдумчивый', 'импульсивный', 'флегматичный', 'дотошно-педантичный', 'ершистый',
  'самоуверенный', 'застенчивый', 'ироничный', 'сварливый', 'доверчивый',
  'расчётливый', 'взбалмошный', 'угрюмый', 'болтливый', 'капризный', 'дотошный',
  'колючий', 'покладистый', 'ушлый', 'наигранно-вежливый', 'взвинченный',
  'равнодушный', 'дотошно-недоверчивый', 'себе на уме', 'горячий', 'занятой',
  'мечтательный', 'приземлённый', 'обозлённый на всех', 'вечно спешащий',
]

/**
 * 16 behavioural archetypes. This is the strongest realism lever: each one is a
 * recognisably different KIND of person with a distinct goal and reaction
 * pattern, so two conversations almost never feel the same. `brief` is written
 * as a direct instruction to the LLM ("веди себя так: ...").
 */
const ARCHETYPES: readonly SimArchetype[] = [
  {
    id: 'skeptic',
    label: 'Скептик',
    brief:
      'Уверен, что это развод. Постоянно ищет подвох, требует доказательств, недоверчиво переспрашивает. Легко срывается, если чуют обман.',
    moodBias: -0.2, patienceBias: -0.1, talkativeness: 0.4,
  },
  {
    id: 'bargainer',
    label: 'Торгаш',
    brief:
      'Всё меряет деньгами, пытается выторговать больше, уточняет каждую цифру, торгуется за ставку и выплаты. Прагматичный.',
    moodBias: 0, patienceBias: 0.1, talkativeness: 0.6,
  },
  {
    id: 'desperate',
    label: 'Отчаявшийся',
    brief:
      'Очень нужны деньги срочно (долги, кредит, нечем кормить семью). Готов почти на всё, цепляется за любую возможность, торопит.',
    moodBias: -0.1, patienceBias: 0.3, talkativeness: 0.7,
  },
  {
    id: 'naive',
    label: 'Наивный',
    brief:
      'Верит всему, что говорят, задаёт простые вопросы, не понимает подвоха. Доверчивый и немного растерянный.',
    moodBias: 0.2, patienceBias: 0.4, talkativeness: 0.5,
  },
  {
    id: 'hothead',
    label: 'Вспыльчивый',
    brief:
      'Заводится с полуоборота. Грубит, материт, обвиняет в разводе при малейшем поводе. Импульсивный и агрессивный.',
    moodBias: -0.4, patienceBias: -0.4, talkativeness: 0.6,
  },
  {
    id: 'pro',
    label: 'Деловой',
    brief:
      'Ценит своё время, пишет по делу, задаёт конкретные вопросы, не терпит воды. Сухой, собранный, вежливый но требовательный.',
    moodBias: 0, patienceBias: -0.1, talkativeness: 0.3,
  },
  {
    id: 'chatterbox',
    label: 'Болтун',
    brief:
      'Пишет много и не по делу, рассказывает про свою жизнь, отвлекается на посторонние темы, шутит. Дружелюбный трепач.',
    moodBias: 0.3, patienceBias: 0.3, talkativeness: 1,
  },
  {
    id: 'silent',
    label: 'Молчун',
    brief:
      'Отвечает односложно: «ок», «ясно», «сколько». Тянуть из него слова тяжело. Скупой на текст.',
    moodBias: 0, patienceBias: 0.2, talkativeness: 0.1,
  },
  {
    id: 'student',
    label: 'Студент',
    brief:
      'Молодой, ищет подработку между парами. Сленг, эмодзи, «краш», «изи», торопится, хочет быстрых лёгких денег.',
    moodBias: 0.2, patienceBias: -0.2, talkativeness: 0.6,
  },
  {
    id: 'pensioner',
    label: 'Пенсионер',
    brief:
      'Пожилой человек, пишет вежливо и обстоятельно, плохо разбирается в технологиях, переспрашивает про приложения и карты, осторожен.',
    moodBias: 0.1, patienceBias: 0.5, talkativeness: 0.5,
  },
  {
    id: 'mom',
    label: 'Мама в декрете',
    brief:
      'Ищет подработку из дома с ребёнком на руках. Переживает про график, отвлекается («сек, ребёнок»), практичная.',
    moodBias: 0.1, patienceBias: 0.3, talkativeness: 0.6,
  },
  {
    id: 'cynic',
    label: 'Циник',
    brief:
      'Насмешливый, язвительный, всё обесценивает, подкалывает менеджера, «ну-ну, давай заливай». Не верит, но из интереса ведёт диалог.',
    moodBias: -0.2, patienceBias: 0.1, talkativeness: 0.5,
  },
  {
    id: 'greedy',
    label: 'Жадный',
    brief:
      'Интересует только сумма и как быстро вывести. Про обязанности не спрашивает, «где деньги», «сколько срублю». Меркантильный.',
    moodBias: 0, patienceBias: -0.1, talkativeness: 0.4,
  },
  {
    id: 'cautious',
    label: 'Осторожный',
    brief:
      'Всё проверяет, гуглит компанию, боится дать данные, спрашивает про договор и легальность. Медленно, вдумчиво, недоверчиво.',
    moodBias: 0, patienceBias: 0.2, talkativeness: 0.5,
  },
  {
    id: 'tired',
    label: 'Уставший',
    brief:
      'Пишет после смены, вымотанный, вялый, без энтузиазма, «ну давай по-быстрому», легко раздражается на лишние вопросы.',
    moodBias: -0.2, patienceBias: -0.2, talkativeness: 0.3,
  },
  {
    id: 'troll',
    label: 'Тролль',
    brief:
      'Пришёл поиздеваться. Стёбет, задаёт абсурдные вопросы, специально тупит, ржёт над менеджером. Не собирается работать.',
    moodBias: 0.1, patienceBias: 0.1, talkativeness: 0.7,
  },
]

/** Real day-jobs / life situations that ground the persona. */
const OCCUPATIONS = [
  'работает на стройке', 'таксует', 'сидит без работы третий месяц',
  'работает продавцом в магазине', 'грузчик на складе', 'учится в колледже',
  'в декрете с ребёнком', 'на пенсии', 'работает вахтой на севере',
  'официант в кафе', 'разнорабочий', 'бывший военный', 'работает охранником',
  'сварщик', 'парикмахер', 'работает на заводе посменно', 'курьер',
  'самозанятый, перебивается заказами', 'работает уборщицей', 'слесарь',
  'сидит дома по здоровью', 'подрабатывает репетитором', 'бариста',
  'работает мастером маникюра', 'дальнобойщик', 'фрилансер без заказов',
  'кассир в пятёрочке', 'работает на мойке', 'электрик', 'штукатур-маляр',
  'кладовщик', 'комплектовщик на складе', 'воспитатель в саду', 'медсестра',
  'фельдшер на скорой', 'работает в шиномонтаже', 'автослесарь', 'плиточник',
  'повар в столовой', 'кондитер на дому', 'швея', 'администратор в салоне',
  'менеджер по продажам', 'оператор call-центра', 'системный админ', 'верстальщик',
  'монтажник натяжных потолков', 'работает в доставке еды', 'бухгалтер на удалёнке',
  'ищет первую работу после армии', 'студент-заочник, подрабатывает', 'ИП, бизнес встал',
  'сиделка', 'мастер по ремонту телефонов', 'диспетчер', 'сторож на базе',
]

/** Why they're looking for work — the motivation. */
const MOTIVATIONS = [
  'нужны деньги на кредит', 'копит на отпуск', 'нечем платить за квартиру',
  'хочет подработку к зарплате', 'ищет что-то на удалёнке',
  'надоело на основной работе', 'нужны деньги срочно, долги',
  'хочет накопить на машину', 'просто пробует, интересно',
  'сократили с прошлой работы', 'хочет уйти от начальника-самодура',
  'нужны деньги на лечение', 'копит на свадьбу', 'хочет финансовую подушку',
  'ребёнок пошёл в школу, нужны деньги', 'платит алименты, не хватает',
  'хочет уволиться и работать на себя', 'нужны карманные деньги',
  'горит микрозайм, нужно закрыть', 'зарплату задержали, не на что жить',
  'жена в декрете, тянет один', 'хочет помочь родителям деньгами',
  'откладывает на первый взнос по ипотеке', 'надо отдать долг другу',
  'потерял работу из-за закрытия фирмы', 'хочет сменить сферу, пробует новое',
  'скучно дома, хочет чем-то заняться и подзаработать', 'коплю на учёбу ребёнку',
  'нужно на ремонт машины после аварии', 'просто ��видел объявление, стало любопытно',
  'хочет доказать себе, что может зарабатывать сам', 'копит на переезд в другой город',
]

/** Regions/cities for flavour + light dialect hints. */
const REGIONS = [
  'Москва', 'Питер', 'Краснодар', 'Екатеринбург', 'Новосибирск', 'Казань',
  'Ростов-на-Дону', 'Челябинск', 'Самара', 'Уфа', 'Пермь', 'Воронеж',
  'Волгоград', 'Красноярск', 'Саратов', 'Тюмень', 'Ижевск', 'Барнаул',
  'Иркутск', 'Хабаровск', 'Владивосток', 'Махачкала', 'посёлок под Тверью',
  'небольшой город в Сибири', 'село в Краснодарском крае',
  'Нижний Новгород', 'Омск', 'Тольятти', 'Кемерово', 'Тула', 'Рязань',
  'Липецк', 'Киров', 'Чебоксары', 'Калининград', 'Астрахань', 'Оренбург',
  'Ставрополь', 'Курск', 'Брянск', 'Сочи', 'Симферополь', 'Якутск', 'Сургут',
  'Нижневартовск', 'Норильск', 'посёлок в Ленобласти', 'деревня под Воронежем',
  'райцентр в Башкирии', 'город-миллионник, не важно какой',
]

/** Concrete life details a persona might drop mid-chat. */
const LIFE_DETAILS = [
  'двое детей', 'ипотека', 'живёт с родителями', 'снимает однушку',
  'недавно развёлся', 'кот и собака дома', 'учится на заочке',
  'машина в кредит', 'работает по 12 часов', 'только переехал в город',
  'подрабатывал курьером раньше', 'уже кидали на такой работе',
  'сестра посоветовала', 'сидит на больничном', 'скоро отпуск',
  'копит на ремонт', 'нет высшего образования', 'служил в армии',
  'трое детей, младший грудной', 'ухаживает за пожилой мамой', 'снимает с другом квартиру',
  'платит два кредита сразу', 'недавно похоронил отца', 'живёт в общаге',
  'дочка-студентка на платном', 'взял микрозайм, теперь жалеет', 'аллергия на кошек',
  'фанат рыбалки', 'болеет за спартак', 'бросил курить месяц назад',
  'права получил, машины пока нет', 'работал за границей на стройке', 'разводится сейчас',
  'сидит в декрете, скучает по работе', 'переехал из деревни в город', 'копит на пластику',
  'подрабатывал в такси по ночам', 'есть татуировки, стесняется на работе',
]

/** Verbal tics / filler catchphrases sprinkled into messages. */
const QUIRKS_POOL = [
  'короче', 'ну это самое', 'типа', 'блин', 'сори', 'кстати', 'слушай',
  'братан', 'по факту', 'как бы', 'ну ты понял', 'в общем', 'значит',
  'вот', 'ясно-понятно', 'ну такое', 'если чё', 'бл', 'эт самое',
  'по-любому', 'зуб даю', 'чё как', 'ну вот', 'слышь', 'в натуре', 'реально',
  'походу', 'в принципе', 'такое дело', 'на самом деле', 'честно говоря',
  'да ладно', 'ну смотри', 'прикинь', 'ёпрст', 'ёшкин кот', 'ну как бы да',
  'это самое', 'вобщем', 'канеш', 'ща', 'мб', 'емнип', 'кмк', 'имхо',
  'ну да ну да', 'ага понятно', 'хз короче', 'ну не знаю', 'вроде того',
  'дык', 'стало быть', 'грубо говоря', 'если честно', 'по идее', 'сути',
]

function makeBackstory(): SimBackstory {
  return {
    occupation: pick(OCCUPATIONS),
    motivation: pick(MOTIVATIONS),
    region: pick(REGIONS),
    detail: pick(LIFE_DETAILS),
  }
}

/** Roll 0–3 distinct verbal tics for a persona. */
function rollQuirks(): string[] {
  const n = randInt(0, 3)
  if (n === 0) return []
  return shuffle(QUIRKS_POOL).slice(0, n)
}

/** Roll 2–3 free-form character traits (drawn from TEMPERS, deduped). */
function rollTraits(seed: string): string[] {
  const n = randInt(2, 3)
  const set = new Set<string>([seed])
  while (set.size < n + 1) set.add(pick(TEMPERS))
  return Array.from(set)
}

/**
 * The private agenda each simulated client carries into the chat. This is what
 * turns a reactive chatter into a scenario with an ARC: the client is trying to
 * REACH this outcome, so across the dialogue they push forward (probe → weigh →
 * decide) instead of endlessly circling. Rolled once at spawn.
 */
const GOALS = [
  'понять, сколько реально можно заработать, и согласиться — но только если это не развод',
  'выяснить все детали и подводные камни, а потом решить; на предоплату идти очень не хочет',
  'по-быстрому узнать суть и деньги, времени вникать нет — либо сразу заходит, либо сливается',
  'вытрясти максимум информации из менеджера и уйти, ничего не заплатив',
  'проверить, не мошенники ли это, поймать на противоречиях и, если разведут, послать',
  'реально нужны деньги срочно, готов почти на всё — но боится, что кинут на предоплате',
  'сравнить с другим вариантом, который уже нашёл, и выбрать где выгоднее',
  'вроде интересно, но постоянно сомневается и тянет с решением, легко спугнуть',
  'хочет работать честно и официально, насторожится от любой серой схемы',
  'настроен поторговаться и выбить условия получше, прежде чем на что-то соглашаться',
]

function rollGoal(): string {
  return pick(GOALS)
}

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
  // Pick the behavioural archetype first — it colours age, mood and pacing.
  const archetype = pick(ARCHETYPES)

  const gender: SimGender = chance(0.55) ? 'male' : 'female'
  const first = pick(gender === 'male' ? MALE_FIRST : FEMALE_FIRST)
  const baseLast = pick(MALE_LAST)
  const last = gender === 'male' ? baseLast : femaleLast(baseLast)

  // Age roughly consistent with the archetype so a «Студент» isn't 50.
  const age =
    archetype.id === 'student'
      ? randInt(17, 23)
      : archetype.id === 'pensioner'
        ? randInt(58, 74)
        : archetype.id === 'mom'
          ? randInt(24, 38)
          : randInt(19, 55)

  // Hotheads / skeptics skew the effective aggression up a bit.
  const moodBias = archetype.moodBias ?? 0
  const effAggression = Math.max(
    0,
    Math.min(100, aggression + (moodBias < 0 ? -moodBias * 55 : 0)),
  )

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

  const temper = pick(TEMPERS)

  return {
    name,
    handle,
    username,
    gender,
    channelType,
    age,
    temper,
    jobHook: pick(JOB_HOOKS),
    tone,
    style: rollStyle(effAggression, tone),
    archetype,
    backstory: makeBackstory(),
    quirks: rollQuirks(),
    traits: rollTraits(temper),
    goal: rollGoal(),
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
/**
 * Replace typographic dashes (em «—», en «–», horizontal bar «―», figure dash,
 * and the Unicode minus «−») with human punctuation:
 *   - a dash used as a spaced separator  → a comma (reads natural in RU chat)
 *   - any other dash (line start, numeric range, glued) → a plain hyphen "-"
 * Then it repairs any doubled comma the substitution could create.
 */
function deDash(text: string): string {
  return text
    .replace(/\s+[—–―‒−]\s+/g, ', ')
    .replace(/[—–―‒−]/g, '-')
    .replace(/\s*,\s*,\s*/g, ', ')
    .replace(/\s{2,}/g, ' ')
}

/**
 * Split a punctuation-less run-on into two chunks at a word gap near the middle
 * (with a little jitter) so no-punctuation personas still send separate
 * messages instead of one long line.
 */
function splitRunOn(text: string): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length < 6) return [text]
  const mid = Math.round(words.length / 2)
  const at = Math.max(2, Math.min(words.length - 2, mid + randInt(-1, 1)))
  return [words.slice(0, at).join(' '), words.slice(at).join(' ')]
}

/**
 * Break one generated reply into 1..N chat "bubbles" the way a real person
 * fires off several short messages instead of one wall of text. Most replies
 * stay a single bubble; sometimes they split into 2-3 (rarely 4). Works for
 * both punctuated and no-punctuation personas. The engine posts the first
 * bubble immediately and the rest with human "typing" gaps.
 */
export function splitIntoMessages(text: string, style: SimStyle): string[] {
  const clean = text.trim()
  if (!clean) return []

  // Very short lines are always a single bubble.
  const words = clean.split(/\s+/).filter(Boolean)
  if (clean.length < 24 || words.length < 4) return [clean]

  // People don't ALWAYS split — keep it one message a good chunk of the time.
  // Terser personas (short, clipped writers) burst into separate messages more.
  const terse = style.terseness ?? 0.5
  const pSingle = Math.max(0.2, 0.55 - terse * 0.25)
  if (chance(pSingle)) return [clean]

  // Prefer explicit line breaks, then sentence boundaries.
  let segments = clean
    .split(/\n+/)
    .flatMap((p) => p.match(/[^.!?…]+[.!?…]+|\S[^.!?…]*$/g) ?? [p])
    .map((s) => s.trim())
    .filter(Boolean)

  // No-punctuation text collapses to a single segment: fall back to a mid-point
  // split so these personas still burst into two messages.
  if (segments.length < 2) segments = splitRunOn(clean)
  if (segments.length < 2) return [clean]

  // Group adjacent segments into bubbles, breaking with a moderate chance and
  // capping the count so we never spray a dozen fragments.
  const maxParts = 2 + (chance(0.35) ? 1 : 0) + (chance(0.1) ? 1 : 0) // 2..4
  const parts: string[] = []
  let cur = ''
  for (const seg of segments) {
    const canBreak = cur !== '' && parts.length + 1 < maxParts
    if (canBreak && chance(0.55)) {
      parts.push(cur)
      cur = seg
    } else {
      cur = cur ? `${cur} ${seg}` : seg
    }
  }
  if (cur.trim()) parts.push(cur.trim())

  // Merge away useless 1-2 char fragments so no bubble is just punctuation.
  const bubbles: string[] = []
  for (const raw of parts) {
    const p = raw.trim()
    if (!p) continue
    if (p.length < 3 && bubbles.length > 0) {
      bubbles[bubbles.length - 1] += ` ${p}`
    } else {
      bubbles.push(p)
    }
  }
  return bubbles.length > 0 ? bubbles : [clean]
}

export function applyStyle(text: string, style: SimStyle): string {
  let out = text.trim()
  if (!out) return out

  // Kill typographic long dashes — the single biggest "written by an AI" tell.
  // A real person in chat never types «—»/«–»; they use a comma or a plain
  // hyphen. This runs on every generated line (belt-and-suspenders on top of
  // the prompt rule), so a stray dash can never reach the manager.
  out = deDash(out)

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
/*  Human "sбои" — typos-with-correction, autocorrect, strays, duplicates    */
/*  Applied at DELIVERY time (per bubble) so they read as separate messages, */
/*  exactly how a real person fixes themselves in chat.                      */
/* ========================================================================= */

/** Emojis people actually fire as a standalone reaction to a message. */
const REACTION_EMOJIS = ['👍', '😂', '🔥', '🤝', '👌', '🤔', ')', '))', ')))', '🙃', '😅', '🤷']

/** A standalone reaction "message" (emoji or a bracket-smiley), no words. */
export function reactionMessage(): string {
  return pick(REACTION_EMOJIS)
}

/**
 * Given the ordered bubbles the persona is about to send, occasionally weave in
 * believable human glitches, returning the NEW ordered list of bubbles.
 *
 * IMPORTANT — we deliberately DO NOT do "self-corrections" here anymore:
 *   • no «*слово» typo-then-correction bubbles, and
 *   • no fixed-list autocorrect ("сейчас"→"сейчак") with a standalone fix.
 * Both were dead giveaways: the «*слово» pattern screams "scripted bot", and the
 * autocorrect list reused the SAME handful of misspellings across every dialog,
 * so different "people" fixed the exact same words the exact same way. What's
 * left are glitches that are genuinely random and non-repetitive:
 *   • accidental early send — a short unfinished fragment fired before the full.
 *   • duplicate            — the same short bubble sent twice (double-tap send).
 *
 * Rates are deliberately low so glitches are seasoning, not noise. `typoRate`
 * scales how error-prone this persona is (polite personas ~never glitch).
 */
export function humanizeBubbles(bubbles: string[], style: SimStyle): string[] {
  if (bubbles.length === 0) return bubbles
  const glitchiness = Math.max(0, Math.min(1, style.typoRate ?? 0))
  if (glitchiness <= 0.02) return bubbles

  const out: string[] = []
  for (let idx = 0; idx < bubbles.length; idx++) {
    const bubble = bubbles[idx]
    const words = bubble.split(/\s+/).filter(Boolean)

    // --- accidental early send: fire the first 1-2 words as a stray, then the
    // full bubble (as if the send button was hit too soon). Only on longer ones.
    if (idx === 0 && words.length >= 5 && chance(glitchiness * 0.35)) {
      out.push(words.slice(0, randInt(1, 2)).join(' '))
    }

    out.push(bubble)

    // --- accidental duplicate (double-tap) on short bubbles ----------------
    if (words.length <= 4 && chance(glitchiness * 0.15)) {
      out.push(bubble)
    }
  }
  return out
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
  'здравствуйте хотел бы попробов��ть {hook}',
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
