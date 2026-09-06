import { describe, it, expect } from 'vitest'
import { normalizeTurns, lastUserText, fallbackReply } from './run-assistant'
import { ASSISTANT_HISTORY_LIMIT } from './assistant'
import type { ConsoleIntent } from './intents'

/**
 * Pure helpers of the AI-manager co-pilot. These run on every turn (both the
 * streaming route and the server action) BEFORE the model is called, so their
 * behavior is load-bearing even when the gateway is down. Kept deterministic
 * and unit-tested so history trimming / sanitization can't silently regress.
 */
describe('normalizeTurns', () => {
  it('returns an empty array for undefined or empty history', () => {
    expect(normalizeTurns(undefined)).toEqual([])
    expect(normalizeTurns([])).toEqual([])
  })

  it('drops blank and non-string content', () => {
    const out = normalizeTurns([
      { role: 'user', content: '  ' },
      { role: 'user', content: 'real' },
      // @ts-expect-error deliberately malformed input from the client
      { role: 'user', content: 123 },
      // @ts-expect-error deliberately malformed input from the client
      null,
    ])
    expect(out).toEqual([{ role: 'user', content: 'real' }])
  })

  it('trims content and coerces unknown roles to user', () => {
    const out = normalizeTurns([
      { role: 'assistant', content: '  hi  ' },
      // @ts-expect-error unknown role must collapse to 'user'
      { role: 'system', content: 'x' },
    ])
    expect(out).toEqual([
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'x' },
    ])
  })

  it('keeps only the last ASSISTANT_HISTORY_LIMIT turns', () => {
    const many = Array.from({ length: ASSISTANT_HISTORY_LIMIT + 8 }, (_, i) => ({
      role: 'user' as const,
      content: `m${i}`,
    }))
    const out = normalizeTurns(many)
    expect(out).toHaveLength(ASSISTANT_HISTORY_LIMIT)
    // The window is the tail, so the first surviving message is offset by 8.
    expect(out[0]?.content).toBe('m8')
    expect(out.at(-1)?.content).toBe(`m${ASSISTANT_HISTORY_LIMIT + 7}`)
  })

  it('caps a single message at 2000 characters', () => {
    const out = normalizeTurns([{ role: 'user', content: 'a'.repeat(5000) }])
    expect(out[0]?.content).toHaveLength(2000)
  })
})

describe('lastUserText', () => {
  it('returns the most recent user utterance', () => {
    expect(
      lastUserText([
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ]),
    ).toBe('second')
  })

  it('ignores assistant turns and returns "" when there is no user turn', () => {
    expect(lastUserText([{ role: 'assistant', content: 'only bot' }])).toBe('')
    expect(lastUserText([])).toBe('')
  })
})

describe('fallbackReply', () => {
  it('gives a distinct acknowledgement per known intent', () => {
    const intents: ConsoleIntent[] = [
      'settings',
      'aggressiveness',
      'knowledge',
      'training',
      'corrections',
      'dialogs',
      'logs',
    ]
    const replies = intents.map(fallbackReply)
    // Every known intent produces a non-empty, unique line.
    for (const r of replies) expect(r.trim().length).toBeGreaterThan(0)
    expect(new Set(replies).size).toBe(replies.length)
  })

  it('falls back to the no-key message for help/unknown', () => {
    expect(fallbackReply('help')).toContain('ИИ-ключ')
    // Unknown intent hits the same default branch.
    expect(fallbackReply('totally-unknown' as ConsoleIntent)).toContain(
      'ИИ-ключ',
    )
  })
})
