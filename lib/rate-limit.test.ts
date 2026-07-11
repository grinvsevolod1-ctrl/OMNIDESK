import { describe, expect, it } from 'vitest'
import { rateLimit } from './rate-limit'

function uniqueKey(): string {
  return `test:${Math.random().toString(36).slice(2)}:${Date.now()}`
}

describe('rateLimit', () => {
  it('allows hits up to the limit and blocks the next one', () => {
    const key = uniqueKey()
    const limit = 3
    const window = 60_000

    const first = rateLimit(key, limit, window)
    expect(first.allowed).toBe(true)
    expect(first.remaining).toBe(2)

    rateLimit(key, limit, window)
    const third = rateLimit(key, limit, window)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)

    const fourth = rateLimit(key, limit, window)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
    expect(fourth.retryAfterSec).toBeGreaterThan(0)
  })

  it('keeps counting while abuse continues (stays blocked)', () => {
    const key = uniqueKey()
    rateLimit(key, 1, 60_000)
    expect(rateLimit(key, 1, 60_000).allowed).toBe(false)
    expect(rateLimit(key, 1, 60_000).allowed).toBe(false)
  })

  it('starts a fresh window once the previous one has elapsed', () => {
    const key = uniqueKey()
    // A zero-length window means the bucket is always expired on the next call,
    // so every hit opens a brand new window and is allowed.
    const first = rateLimit(key, 1, 0)
    expect(first.allowed).toBe(true)
    const second = rateLimit(key, 1, 0)
    expect(second.allowed).toBe(true)
  })

  it('isolates counters per key', () => {
    const a = uniqueKey()
    const b = uniqueKey()
    rateLimit(a, 1, 60_000)
    expect(rateLimit(a, 1, 60_000).allowed).toBe(false)
    // A different key is unaffected by the first key's exhausted budget.
    expect(rateLimit(b, 1, 60_000).allowed).toBe(true)
  })

  it('reports a Retry-After of at least one second when blocked', () => {
    const key = uniqueKey()
    rateLimit(key, 1, 5_000)
    const blocked = rateLimit(key, 1, 5_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(5)
  })
})
