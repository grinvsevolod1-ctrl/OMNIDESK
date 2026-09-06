import { describe, it, expect } from 'vitest'
import {
  catalogByCategory,
  findPlatform,
  platformLogoUrl,
  platformMonogram,
  platformOrCustom,
  searchCatalog,
  SOURCE_CATEGORY_META,
  TRAFFIC_SOURCE_CATALOG,
} from './traffic-source-catalog'

describe('traffic source catalog', () => {
  it('каждая платформа имеет уникальный ключ', () => {
    const keys = TRAFFIC_SOURCE_CATALOG.map((p) => p.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('всегда содержит «свой источник» (custom) последним', () => {
    const last = TRAFFIC_SOURCE_CATALOG[TRAFFIC_SOURCE_CATALOG.length - 1]
    expect(last.key).toBe('custom')
  })

  it('каждая категория платформы описана в мете', () => {
    for (const p of TRAFFIC_SOURCE_CATALOG) {
      expect(SOURCE_CATEGORY_META[p.category]).toBeDefined()
    }
  })

  it('hex — валидный 6-значный цвет', () => {
    for (const p of TRAFFIC_SOURCE_CATALOG) {
      expect(p.hex).toMatch(/^[0-9A-Fa-f]{6}$/)
    }
  })

  describe('searchCatalog', () => {
    it('пустой запрос возвращает весь каталог', () => {
      expect(searchCatalog('')).toHaveLength(TRAFFIC_SOURCE_CATALOG.length)
      expect(searchCatalog('   ')).toHaveLength(TRAFFIC_SOURCE_CATALOG.length)
    })

    it('находит по названию (регистронезависимо)', () => {
      const r = searchCatalog('яндекс')
      expect(r.some((p) => p.key === 'yandex_direct')).toBe(true)
    })

    it('находит по синониму', () => {
      expect(searchCatalog('adwords').some((p) => p.key === 'google_ads')).toBe(
        true,
      )
      expect(searchCatalog('вк').some((p) => p.key === 'vk_ads')).toBe(true)
      expect(searchCatalog('телега').some((p) => p.key === 'telegram_ads')).toBe(
        true,
      )
    })

    it('находит по ключу', () => {
      expect(searchCatalog('tiktok').some((p) => p.key === 'tiktok_ads')).toBe(
        true,
      )
    })

    it('возвращает пусто на несуществующем запросе', () => {
      expect(searchCatalog('zzzнеттакого')).toHaveLength(0)
    })
  })

  describe('findPlatform / platformOrCustom', () => {
    it('находит существующую платформу', () => {
      expect(findPlatform('yandex_direct')?.name).toBe('Яндекс Директ')
    })

    it('возвращает undefined для неизвестной', () => {
      expect(findPlatform('nope')).toBeUndefined()
    })

    it('platformOrCustom откатывается на custom', () => {
      expect(platformOrCustom('nope').key).toBe('custom')
      expect(platformOrCustom('vk_ads').key).toBe('vk_ads')
    })
  })

  describe('platformLogoUrl', () => {
    it('строит jsDelivr URL для slug', () => {
      expect(platformLogoUrl('yandex')).toContain(
        '/icons/yandex/default.svg',
      )
      expect(platformLogoUrl('yandex', 'mono')).toContain(
        '/icons/yandex/mono.svg',
      )
    })

    it('возвращает null для отсутствующего slug', () => {
      expect(platformLogoUrl(null)).toBeNull()
    })
  })

  describe('platformMonogram', () => {
    it('берёт первые буквы двух слов', () => {
      expect(platformMonogram({ name: 'Google Ads' } as never)).toBe('GA')
    })

    it('берёт две буквы из одного слова', () => {
      expect(platformMonogram({ name: 'Avito' } as never)).toBe('AV')
    })

    it('игнорирует спецсимволы', () => {
      expect(platformMonogram({ name: '2ГИС' } as never)).toBe('2Г')
    })
  })

  describe('catalogByCategory', () => {
    it('группирует и сортирует категории по order', () => {
      const groups = catalogByCategory()
      const orders = groups.map((g) => SOURCE_CATEGORY_META[g.category].order)
      expect(orders).toEqual([...orders].sort((a, b) => a - b))
    })

    it('сумма элементов групп равна размеру входа', () => {
      const filtered = searchCatalog('ads')
      const groups = catalogByCategory(filtered)
      const total = groups.reduce((s, g) => s + g.items.length, 0)
      expect(total).toBe(filtered.length)
    })
  })
})
