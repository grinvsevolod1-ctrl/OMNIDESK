import { describe, expect, it } from 'vitest'
import {
  INTENT_BY_ID,
  INTENT_CATALOGUE,
  classifyByKeywords,
  type ServersIntent,
} from './intents'

describe('INTENT_CATALOGUE', () => {
  it('has unique intent ids', () => {
    const ids = INTENT_CATALOGUE.map((m) => m.intent)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every entry has label, description, examples and keywords', () => {
    for (const m of INTENT_CATALOGUE) {
      expect(m.label.length).toBeGreaterThan(0)
      expect(m.description.length).toBeGreaterThan(0)
      expect(m.examples.length).toBeGreaterThan(0)
      expect(m.keywords.length).toBeGreaterThan(0)
    }
  })

  it('is indexed by id', () => {
    for (const m of INTENT_CATALOGUE) {
      expect(INTENT_BY_ID[m.intent]).toBe(m)
    }
  })
})

describe('classifyByKeywords', () => {
  const cases: Array<{ text: string; expected: ServersIntent }> = [
    { text: 'Давай добавим новый сервер', expected: 'add_server' },
    { text: 'подключи VPS', expected: 'add_server' },
    { text: 'Разверни этот репозиторий на проде', expected: 'deploy' },
    { text: 'запускай установку github проекта', expected: 'deploy' },
    { text: 'задеплой сайт', expected: 'deploy' },
    { text: 'покажи мои серверы', expected: 'servers' },
    { text: 'какая нагрузка на сервере', expected: 'servers' },
    { text: 'покажи логи установки', expected: 'logs' },
    { text: 'что происходит на сервере, как идёт деплой', expected: 'logs' },
  ]
  for (const { text, expected } of cases) {
    it(`routes "${text}" -> ${expected}`, () => {
      expect(classifyByKeywords(text).intent).toBe(expected)
    })
  }

  it('falls back to help for gibberish', () => {
    const res = classifyByKeywords('qwerty zxcvb 123')
    expect(res.intent).toBe('help')
    expect(res.confidence).toBe(0)
  })

  it('returns help with zero confidence for empty input', () => {
    expect(classifyByKeywords('   ')).toEqual({ intent: 'help', confidence: 0 })
  })

  it('gives higher confidence when more keywords match', () => {
    const weak = classifyByKeywords('сервер')
    const strong = classifyByKeywords('покажи список серверов, метрики и приложения')
    expect(strong.confidence).toBeGreaterThan(weak.confidence)
  })
})
