import { describe, expect, it } from 'vitest'
import { rateLimit } from './rate-limit'

function uniqueKey(): string {
  return `test:${Math.random().toString(36).slice(2)}:${Date.now()}`
}

// No Redis env is set under test, so rateLimit resolves via the in-memory store.
describe('rateLimit', () => {
  it('allows hits up to the limit and blocks the next one', async () => {
    const key = uniqueKey()
    const limit = 3
    const window = 60_000

    const first = await rateLimit(key, limit, window)
    expect(first.allowed).toBe(true)
    expect(first.remaining).toBe(2)

    await rateLimit(key, limit, window)
    const third = await rateLimit(key, limit, window)
    expect(third.allowed).toBe(true)
    expect(third.remaining).toBe(0)

    const fourth = await rateLimit(key, limit, window)
    expect(fourth.allowed).toBe(false)
    expect(fourth.remaining).toBe(0)
    expect(fourth.retryAfterSec).toBeGreaterThan(0)
  })

  it('keeps counting while abuse continues (stays blocked)', async () => {
    const key = uniqueKey()
    await rateLimit(key, 1, 60_000)
    expect((await rateLimit(key, 1, 60_000)).allowed).toBe(false)
    expect((await rateLimit(key, 1, 60_000)).allowed).toBe(false)
  })

  it('starts a fresh window once the previous one has elapsed', async () => {
    const key = uniqueKey()
    // A zero-length window means the bucket is always expired on the next call,
    // so every hit opens a brand new window and is allowed.
    const first = await rateLimit(key, 1, 0)
    expect(first.allowed).toBe(true)
    const second = await rateLimit(key, 1, 0)
    expect(second.allowed).toBe(true)
  })

  it('isolates counters per key', async () => {
    const a = uniqueKey()
    const b = uniqueKey()
    await rateLimit(a, 1, 60_000)
    expect((await rateLimit(a, 1, 60_000)).allowed).toBe(false)
    // A different key is unaffected by the first key's exhausted budget.
    expect((await rateLimit(b, 1, 60_000)).allowed).toBe(true)
  })

  it('reports a Retry-After of at least one second when blocked', async () => {
    const key = uniqueKey()
    await rateLimit(key, 1, 5_000)
    const blocked = await rateLimit(key, 1, 5_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterSec).toBeGreaterThanOrEqual(1)
    expect(blocked.retryAfterSec).toBeLessThanOrEqual(5)
  })
})
