import { describe, expect, it } from 'vitest'
import {
  classifyOverviewQuery,
  matchAllSourceNames,
  matchSourceName,
  normalizeQuery,
  parsePeriod,
} from './intents'

/**
 * Уровень 1 каскада ИИ-строки Обзора — детерминированный разбор без модели.
 * Эти функции закрывают большинство запросов с нулевой стоимостью токенов,
 * поэтому их поведение фиксируется тестами: регресс тут = скрытый рост
 * расходов на LLM и/или неверные быстрые ответы.
 */

describe('normalizeQuery', () => {
  it('lowercases, maps ё→е and strips punctuation', () => {
    expect(normalizeQuery('Отчёт: ТОП, источников!')).toBe('отчет топ источников')
  })

  it('collapses whitespace', () => {
    expect(normalizeQuery('  как   дела  ')).toBe('как дела')
  })
})

describe('parsePeriod', () => {
  const now = new Date('2026-08-16T15:30:00')

  it('parses «сегодня» as the current local day', () => {
    const p = parsePeriod('как дела сегодня', now)
    expect(p?.label).toBe('сегодня')
    expect(new Date(p!.fromISO).getDate()).toBe(16)
  })

  it('parses «вчера» as one full previous day', () => {
    const p = parsePeriod('сколько потратили вчера', now)
    expect(p?.label).toBe('вчера')
    const from = new Date(p!.fromISO)
    const to = new Date(p!.toISO)
    expect(to.getTime() - from.getTime()).toBe(86_400_000)
  })

  it('parses «за N дней» with clamping', () => {
    expect(parsePeriod('за 14 дней', now)?.label).toBe('за 14 дн.')
    expect(parsePeriod('за 999 дней', now)?.label).toBe('за 365 дн.')
  })

  it('parses week and month words', () => {
    expect(parsePeriod('итоги за неделю', now)?.label).toBe('за неделю')
    expect(parsePeriod('отчет за месяц', now)?.label).toBe('за месяц')
  })

  it('returns null when no period is mentioned', () => {
    expect(parsePeriod('топ источников', now)).toBeNull()
  })
})

describe('matchSourceName', () => {
  const sources = [
    { id: '1', name: 'Авито' },
    { id: '2', name: 'Яндекс Директ' },
    { id: '3', name: 'Телеграм посевы' },
  ]

  it('finds exact name', () => {
    expect(matchSourceName('авито', sources)?.id).toBe('1')
  })

  it('finds name inside a longer query', () => {
    expect(matchSourceName('покажи цифры по яндекс директ', sources)?.id).toBe('2')
  })

  it('finds source by partial query of 3+ chars', () => {
    expect(matchSourceName('посевы', sources)?.id).toBe('3')
  })

  it('returns null for unrelated text', () => {
    expect(matchSourceName('привет мир', sources)).toBeNull()
  })

  it('prefers exact match over substring', () => {
    const withClone = [...sources, { id: '4', name: 'Авито Москва' }]
    expect(matchSourceName('авито', withClone)?.id).toBe('1')
  })
})

describe('matchAllSourceNames', () => {
  const sources = [
    { id: '1', name: 'Авито' },
    { id: '2', name: 'Яндекс Директ' },
    { id: '3', name: 'Телеграм посевы' },
  ]

  it('collects every source mentioned in the text', () => {
    const found = matchAllSourceNames('сравни авито и яндекс директ', sources)
    expect(found.map((s) => s.id).sort()).toEqual(['1', '2'])
  })

  it('returns empty array when nothing matches', () => {
    expect(matchAllSourceNames('как дела', sources)).toEqual([])
  })
})

describe('classifyOverviewQuery', () => {
  it('classifies summary questions confidently', () => {
    const c = classifyOverviewQuery('как дела за неделю')
    expect(c.intent).toBe('summary')
    expect(c.confident).toBe(true)
  })

  it('classifies top/comparison questions', () => {
    expect(classifyOverviewQuery('топ источников').intent).toBe('top_sources')
    expect(classifyOverviewQuery('какой источник лучший').intent).toBe('top_sources')
  })

  it('classifies worst-sources questions separately', () => {
    expect(classifyOverviewQuery('худший источник').intent).toBe('worst_sources')
    expect(classifyOverviewQuery('кто хуже всех работает').intent).toBe(
      'worst_sources',
    )
  })

  it('classifies compare questions', () => {
    expect(classifyOverviewQuery('сравни авито и директ').intent).toBe(
      'compare_sources',
    )
  })

  it('classifies money questions', () => {
    expect(classifyOverviewQuery('сколько потратили за месяц').intent).toBe('money')
    expect(classifyOverviewQuery('баланс по источникам').intent).toBe('money')
  })

  it('classifies lead questions', () => {
    expect(classifyOverviewQuery('сколько лидов передано').intent).toBe('leads')
  })

  it('never answers mutations confidently (they need the model + confirm)', () => {
    const c = classifyOverviewQuery('переименуй авито в авито москва')
    expect(c.confident).toBe(false)
  })

  it('returns unknown for unrelated text', () => {
    const c = classifyOverviewQuery('напиши стихотворение')
    expect(c.intent).toBe('unknown')
    expect(c.confident).toBe(false)
  })
})
