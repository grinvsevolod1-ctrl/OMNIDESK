import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DeadlineError,
  envMs,
  isDeadlineError,
  withDeadline,
} from './with-deadline'

describe('withDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('resolves with the value when the promise settles in time', async () => {
    const p = withDeadline(Promise.resolve(42), 1000, 'fast')
    await expect(p).resolves.toBe(42)
  })

  it('propagates the original rejection untouched', async () => {
    const boom = new Error('boom')
    const p = withDeadline(Promise.reject(boom), 1000, 'failing')
    await expect(p).rejects.toBe(boom)
  })

  it('rejects with DeadlineError once the deadline passes', async () => {
    const never = new Promise<number>(() => {})
    const p = withDeadline(never, 5_000, 'stuck download')
    const assertion = expect(p).rejects.toSatisfy(
      (err: unknown) =>
        isDeadlineError(err) &&
        err.ms === 5_000 &&
        err.message === 'stuck download exceeded 5000ms',
    )
    await vi.advanceTimersByTimeAsync(5_000)
    await assertion
  })

  it('does not fire the deadline after the promise already settled', async () => {
    const p = withDeadline(Promise.resolve('ok'), 1_000)
    await expect(p).resolves.toBe('ok')
    // Advancing past the deadline must not produce an unhandled rejection.
    await vi.advanceTimersByTimeAsync(2_000)
  })

  it('passes the promise through when the deadline is disabled', async () => {
    const never = new Promise<number>(() => {})
    const p = withDeadline(never, 0)
    expect(p).toBe(never)
  })
})

describe('envMs', () => {
  it('reads a positive integer from the environment', () => {
    vi.stubEnv('TEST_TIMEOUT_MS', '2500')
    expect(envMs('TEST_TIMEOUT_MS', 100)).toBe(2500)
    vi.unstubAllEnvs()
  })

  it('falls back on missing, zero, negative or garbage values', () => {
    vi.stubEnv('TEST_TIMEOUT_MS', '')
    expect(envMs('TEST_TIMEOUT_MS', 100)).toBe(100)
    vi.stubEnv('TEST_TIMEOUT_MS', '0')
    expect(envMs('TEST_TIMEOUT_MS', 100)).toBe(100)
    vi.stubEnv('TEST_TIMEOUT_MS', '-5')
    expect(envMs('TEST_TIMEOUT_MS', 100)).toBe(100)
    vi.stubEnv('TEST_TIMEOUT_MS', 'abc')
    expect(envMs('TEST_TIMEOUT_MS', 100)).toBe(100)
    vi.unstubAllEnvs()
  })
})

describe('DeadlineError', () => {
  it('is a real Error with a stable name', () => {
    const err = new DeadlineError(10, 'x')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('DeadlineError')
    expect(isDeadlineError(err)).toBe(true)
    expect(isDeadlineError(new Error('x'))).toBe(false)
  })
})
