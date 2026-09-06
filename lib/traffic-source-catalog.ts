/**
 * Каталог рекламных площадок мира для модалки добавления источника трафика.
 *
 * Единый источник правды по платформам: ключ platform_key (сохраняется в
 * traffic_sources.platform_key), человекочитаемое название, категория, бренд-цвет
 * и логотип. Логотипы — брендовые SVG из theSVG.org через jsDelivr CDN; там, где
 * бренда в реестре нет (Avito, myTarget, 2ГИС, Дзен, RuTube), рисуем монограмму
 * (буква на фоне бренд-цвета) — см. logoSlug === null.
 *
 * Слаги и наличие вариантов проверены по реестру theSVG (default/mono есть у
 * всех перечисленных с logoSlug). Пользователь при использовании логотипов
 * должен соблюдать товарные знаки правообладателей.
 */

export type SourceCategory =
  | 'search'
  | 'social'
  | 'messenger'
  | 'target'
  | 'marketplace'
  | 'video'
  | 'other'

export interface CatalogPlatform {
  /** Стабильный ключ → traffic_sources.platform_key. */
  key: string
  /** Название площадки (RU). */
  name: string
  category: SourceCategory
  /** Бренд-цвет (#hex без решётки) — фон монограммы и акцент карточки. */
  hex: string
  /** Slug в theSVG или null (тогда показываем монограмму). */
  logoSlug: string | null
  /** Локальный логотип (имеет приоритет над theSVG). Рисуется во всю плитку. */
  logoUrl?: string
  /** Валюта по умолчанию для площадки. */
  defaultCurrency: 'RUB' | 'USD' | 'EUR' | 'USDT'
  /** Синонимы для поиска. */
  aliases?: string[]
}

export const SOURCE_CATEGORY_META: Record<
  SourceCategory,
  { label: string; order: number }
> = {
  search: { label: 'Поисковая реклама', order: 1 },
  social: { label: 'Социальные сети', order: 2 },
  messenger: { label: 'Мессенджеры', order: 3 },
  target: { label: 'Таргет и programmatic', order: 4 },
  marketplace: { label: 'Маркетплейсы и классифайды', order: 5 },
  video: { label: 'Видео', order: 6 },
  other: { label: 'Другое', order: 7 },
}

/**
 * Логотип платформы через theSVG (jsDelivr CDN). variant: 'default' цветной,
 * 'mono' одноцветный. null slug → нет логотипа, вызывающий рисует монограмму.
 */
export function platformLogoUrl(
  slug: string | null,
  variant: 'default' | 'mono' = 'default',
): string | null {
  if (!slug) return null
  return `https://cdn.jsdelivr.net/gh/glincker/thesvg@main/public/icons/${slug}/${variant}.svg`
}

export const TRAFFIC_SOURCE_CATALOG: CatalogPlatform[] = [
  // Поисковая реклама
  {
    key: 'yandex_direct',
    name: 'Яндекс Директ',
    category: 'search',
    hex: '000000',
    logoSlug: null,
    logoUrl: '/logos/yandex-direct.svg',
    defaultCurrency: 'RUB',
    aliases: ['яндекс', 'директ', 'yandex direct'],
  },
  {
    key: 'google_ads',
    name: 'Google Ads',
    category: 'search',
    hex: '4285F4',
    logoSlug: 'google-ads',
    defaultCurrency: 'USD',
    aliases: ['гугл', 'adwords', 'google adwords'],
  },
  {
    key: 'bing_ads',
    name: 'Microsoft Ads (Bing)',
    category: 'search',
    hex: '008373',
    logoSlug: 'microsoft-bing',
    defaultCurrency: 'USD',
    aliases: ['bing', 'бинг', 'microsoft'],
  },
  // Социальные сети
  {
    key: 'vk_ads',
    name: 'VK Реклама',
    category: 'social',
    hex: '0077FF',
    logoSlug: 'vk',
    defaultCurrency: 'RUB',
    aliases: ['вк', 'вконтакте', 'vkontakte'],
  },
  {
    key: 'ok_ads',
    name: 'Одноклассники',
    category: 'social',
    hex: 'EE8208',
    logoSlug: 'odnoklassniki',
    defaultCurrency: 'RUB',
    aliases: ['ок', 'одноклассники', 'ok'],
  },
  {
    key: 'meta_ads',
    name: 'Meta (Facebook)',
    category: 'social',
    hex: '0668E1',
    logoSlug: 'meta',
    defaultCurrency: 'USD',
    aliases: ['фейсбук', 'facebook', 'мета'],
  },
  {
    key: 'instagram_ads',
    name: 'Instagram',
    category: 'social',
    hex: 'E4405F',
    logoSlug: 'instagram',
    defaultCurrency: 'USD',
    aliases: ['инстаграм', 'инста', 'instagram'],
  },
  {
    key: 'tiktok_ads',
    name: 'TikTok Ads',
    category: 'social',
    hex: '000000',
    logoSlug: 'tiktok',
    defaultCurrency: 'USD',
    aliases: ['тикток', 'tiktok'],
  },
  {
    key: 'x_ads',
    name: 'X (Twitter)',
    category: 'social',
    hex: '000000',
    logoSlug: 'x-formerly-twitter',
    defaultCurrency: 'USD',
    aliases: ['твиттер', 'twitter', 'x'],
  },
  {
    key: 'reddit_ads',
    name: 'Reddit Ads',
    category: 'social',
    hex: 'FF4500',
    logoSlug: 'reddit',
    defaultCurrency: 'USD',
    aliases: ['реддит', 'reddit'],
  },
  {
    key: 'pinterest_ads',
    name: 'Pinterest',
    category: 'social',
    hex: 'BD081C',
    logoSlug: 'pinterest',
    defaultCurrency: 'USD',
    aliases: ['пинтерест', 'pinterest'],
  },
  {
    key: 'linkedin_ads',
    name: 'LinkedIn Ads',
    category: 'social',
    hex: '0A66C2',
    logoSlug: 'linkedin',
    defaultCurrency: 'USD',
    aliases: ['линкедин', 'linkedin'],
  },
  {
    key: 'snapchat_ads',
    name: 'Snapchat Ads',
    category: 'social',
    hex: 'FFFC00',
    logoSlug: 'snapchat',
    defaultCurrency: 'USD',
    aliases: ['снапчат', 'snapchat'],
  },
  // Мессенджеры
  {
    key: 'telegram_ads',
    name: 'Telegram Ads',
    category: 'messenger',
    hex: '26A5E4',
    logoSlug: 'telegram',
    defaultCurrency: 'EUR',
    aliases: ['телеграм', 'телега', 'telegram'],
  },
  {
    key: 'whatsapp_ads',
    name: 'WhatsApp',
    category: 'messenger',
    hex: '25D366',
    logoSlug: 'whatsapp',
    defaultCurrency: 'USD',
    aliases: ['вотсап', 'ватсап', 'whatsapp'],
  },
  {
    key: 'viber_ads',
    name: 'Viber',
    category: 'messenger',
    hex: '7360F2',
    logoSlug: 'viber',
    defaultCurrency: 'USD',
    aliases: ['вайбер', 'viber'],
  },
  // Таргет и programmatic
  {
    key: 'mytarget',
    name: 'myTarget (VK Ads)',
    category: 'target',
    hex: '2D81E0',
    logoSlug: null,
    defaultCurrency: 'RUB',
    aliases: ['майтаргет', 'mytarget', 'вк адс'],
  },
  {
    key: 'criteo',
    name: 'Criteo',
    category: 'target',
    hex: 'FF6D2D',
    logoSlug: null,
    defaultCurrency: 'EUR',
    aliases: ['критео', 'criteo'],
  },
  // Маркетплейсы и классифайды
  {
    key: 'avito',
    name: 'Avito',
    category: 'marketplace',
    hex: '00AAFF',
    logoSlug: null,
    defaultCurrency: 'RUB',
    aliases: ['авито', 'avito'],
  },
  {
    key: 'wildberries',
    name: 'Wildberries',
    category: 'marketplace',
    hex: 'CB11AB',
    logoSlug: 'wildberries',
    defaultCurrency: 'RUB',
    aliases: ['вб', 'вайлдберриз', 'wildberries'],
  },
  {
    key: 'ozon',
    name: 'Ozon',
    category: 'marketplace',
    hex: '005BFF',
    logoSlug: 'ozon',
    defaultCurrency: 'RUB',
    aliases: ['озон', 'ozon'],
  },
  {
    key: 'twogis',
    name: '2ГИС',
    category: 'marketplace',
    hex: '30B12A',
    logoSlug: null,
    defaultCurrency: 'RUB',
    aliases: ['2гис', '2gis', 'дубльгис'],
  },
  // Видео
  {
    key: 'youtube_ads',
    name: 'YouTube Ads',
    category: 'video',
    hex: 'FF0000',
    logoSlug: 'youtube',
    defaultCurrency: 'USD',
    aliases: ['ютуб', 'youtube'],
  },
  {
    key: 'rutube',
    name: 'RuTube',
    category: 'video',
    hex: '000420',
    logoSlug: null,
    defaultCurrency: 'RUB',
    aliases: ['рутуб', 'rutube'],
  },
  {
    key: 'dzen',
    name: 'Дзен',
    category: 'video',
    hex: '000000',
    logoSlug: null,
    defaultCurrency: 'RUB',
    aliases: ['дзен', 'zen', 'yandex zen'],
  },
  // Другое
  {
    key: 'custom',
    name: 'Свой источник',
    category: 'other',
    hex: '6366F1',
    logoSlug: null,
    defaultCurrency: 'RUB',
    aliases: ['другое', 'custom', 'вручную', 'свой'],
  },
]

/** Найти платформу по ключу. */
export function findPlatform(key: string): CatalogPlatform | undefined {
  return TRAFFIC_SOURCE_CATALOG.find((p) => p.key === key)
}

/** Платформа для отображения — с фолбэком на «Свой источник». */
export function platformOrCustom(key: string): CatalogPlatform {
  return findPlatform(key) ?? TRAFFIC_SOURCE_CATALOG[TRAFFIC_SOURCE_CATALOG.length - 1]
}

/**
 * Поиск по каталогу: по названию, ключу и синонимам (регистронезависимо).
 * Пустой запрос возвращает весь каталог.
 */
export function searchCatalog(queryText: string): CatalogPlatform[] {
  const q = queryText.trim().toLowerCase()
  if (!q) return TRAFFIC_SOURCE_CATALOG
  return TRAFFIC_SOURCE_CATALOG.filter((p) => {
    if (p.name.toLowerCase().includes(q)) return true
    if (p.key.toLowerCase().includes(q)) return true
    return (p.aliases ?? []).some((a) => a.toLowerCase().includes(q))
  })
}

/** Каталог, сгруппированный по категориям в порядке order (для модалки). */
export function catalogByCategory(
  platforms: CatalogPlatform[] = TRAFFIC_SOURCE_CATALOG,
): { category: SourceCategory; label: string; items: CatalogPlatform[] }[] {
  const groups = new Map<SourceCategory, CatalogPlatform[]>()
  for (const p of platforms) {
    const list = groups.get(p.category) ?? []
    list.push(p)
    groups.set(p.category, list)
  }
  return [...groups.entries()]
    .map(([category, items]) => ({
      category,
      label: SOURCE_CATEGORY_META[category].label,
      items,
    }))
    .sort(
      (a, b) =>
        SOURCE_CATEGORY_META[a.category].order -
        SOURCE_CATEGORY_META[b.category].order,
    )
}

/** Подсказка про валюту учёта источника (депозиты приводятся к ней по курсу). */
export const SOURCE_CURRENCIES_HINT =
  'Базовая валюта учёта. Депозиты в другой валюте приводятся к ней по курсу на момент внесения.'

/** Монограмма (1-2 буквы) для платформ без логотипа. */
export function platformMonogram(p: CatalogPlatform): string {
  const cleaned = p.name.replace(/[^\p{L}\p{N} ]/gu, '').trim()
  const parts = cleaned.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return cleaned.slice(0, 2).toUpperCase()
}
