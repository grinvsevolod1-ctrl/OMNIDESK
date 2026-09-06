import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * channel_jobs runner tests with mocked repo + registry.
 *
 * `run()` is the heart of outbound delivery: it decides whether a failed send
 * is dead-lettered, or parked for a FLOOD_WAIT auto-retry. A wrong decision
 * either drops a client's message on the floor (terminal-fail a retriable
 * flood) or cycles forever (retry a permanent rejection). Every branch runs
 * the REAL production code with only the edges (repo, registry) replaced.
 * telegram-errors.js is intentionally REAL — FLOOD_WAIT classification is part
 * of the behavior under test, exactly like telegram-recovery.test.ts.
 */

vi.mock('teleproto', () => ({ TelegramClient: class {}, Api: {} }))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('./repo.js', () => ({
  claimJob: vi.fn(async () => null),
  claimNextQueued: vi.fn(async () => null),
  finishJob: vi.fn(async () => {}),
  rescheduleJob: vi.fn(async () => {}),
  setMessageStatus: vi.fn(async () => {}),
}))

vi.mock('./registry.js', () => ({
  registry: { handleJob: vi.fn(async () => ({ ok: true })) },
}))

// serialize.js is REAL — per-channel ordering is part of the contract, and its
// runSerialized simply awaits the passed thunk for a fresh channel id.
import { processJob } from './jobs.js'
import * as repo from './repo.js'
import { registry } from './registry.js'

const claimJob = vi.mocked(repo.claimJob)
const finishJob = vi.mocked(repo.finishJob)
const rescheduleJob = vi.mocked(repo.rescheduleJob)
const setMessageStatus = vi.mocked(repo.setMessageStatus)
const handleJob = vi.mocked(registry.handleJob)

let channelSeq = 0
function makeJob(overrides?: Partial<repo.JobRecord>): repo.JobRecord {
  return {
    id: 'job-1',
    // Unique channel per job so runSerialized never queues behind a prior test.
    channel_id: `ch-${++channelSeq}`,
    manager_id: 'mgr-1',
    action: 'send_message',
    payload: { messageId: 'msg-1' },
    status: 'queued',
    attempts: 1,
    ...overrides,
  }
}

/** A FLOOD_WAIT error shaped like the SDK's (message + seconds field). */
function floodError(seconds: number): Error {
  const e = new Error(`FLOOD_WAIT_${seconds}`) as Error & { seconds: number }
  e.seconds = seconds
  return e
}

beforeEach(() => {
  vi.clearAllMocks()
  handleJob.mockResolvedValue({ ok: true })
})

describe('processJob claim gate', () => {
  it('does nothing when the job was already taken (claim returns null)', async () => {
    claimJob.mockResolvedValue(null)
    await processJob('job-x')
    expect(handleJob).not.toHaveBeenCalled()
    expect(finishJob).not.toHaveBeenCalled()
  })
})

describe('run: success path', () => {
  it('marks the job done with the handler result', async () => {
    claimJob.mockResolvedValue(makeJob())
    handleJob.mockResolvedValue({ providerMessageId: 'pm-7' })

    await processJob('job-1')

    expect(finishJob).toHaveBeenCalledWith('job-1', true, { providerMessageId: 'pm-7' }, null)
    expect(rescheduleJob).not.toHaveBeenCalled()
  })
})

describe('run: terminal failure (dead-letter)', () => {
  it('a non-flood rejection fails the job terminally with the real reason', async () => {
    claimJob.mockResolvedValue(makeJob())
    handleJob.mockRejectedValue(new Error('USER_IS_BLOCKED'))

    await processJob('job-1')

    expect(rescheduleJob).not.toHaveBeenCalled()
    expect(finishJob).toHaveBeenCalledWith('job-1', false, null, 'USER_IS_BLOCKED')
  })
})

describe('run: FLOOD_WAIT auto-retry', () => {
  it('parks a flood-limited send back in the queue instead of failing', async () => {
    claimJob.mockResolvedValue(makeJob({ attempts: 1 }))
    handleJob.mockRejectedValue(floodError(15))

    await processJob('job-1')

    // delay = floodSecs + RETRY_BUFFER_SECONDS (2)
    expect(rescheduleJob).toHaveBeenCalledWith('job-1', 17, expect.stringContaining('FLOOD_WAIT_15'))
    // the optimistic message is rolled back to 'sent' (no scary "!")
    expect(setMessageStatus).toHaveBeenCalledWith('msg-1', 'sent', null)
    // NOT dead-lettered
    expect(finishJob).not.toHaveBeenCalled()
  })

  it('guardrail: flood wait beyond the 10-min cap is NOT retried', async () => {
    claimJob.mockResolvedValue(makeJob({ attempts: 1 }))
    handleJob.mockRejectedValue(floodError(601))

    await processJob('job-1')

    expect(rescheduleJob).not.toHaveBeenCalled()
    expect(finishJob).toHaveBeenCalledWith('job-1', false, null, expect.stringContaining('FLOOD_WAIT_601'))
  })

  it('guardrail: non-send actions (e.g. start) are never flood-retried', async () => {
    claimJob.mockResolvedValue(makeJob({ action: 'start', payload: {} }))
    handleJob.mockRejectedValue(floodError(15))

    await processJob('job-1')

    expect(rescheduleJob).not.toHaveBeenCalled()
    expect(finishJob).toHaveBeenCalledWith('job-1', false, null, expect.stringContaining('FLOOD_WAIT_15'))
  })

  it('guardrail: the 3rd attempt fails loudly instead of cycling forever', async () => {
    claimJob.mockResolvedValue(makeJob({ attempts: 3 }))
    handleJob.mockRejectedValue(floodError(15))

    await processJob('job-1')

    expect(rescheduleJob).not.toHaveBeenCalled()
    expect(finishJob).toHaveBeenCalledWith('job-1', false, null, expect.stringContaining('FLOOD_WAIT_15'))
  })

  it('fallback: if parking the job fails, it dead-letters and re-flags the message failed', async () => {
    claimJob.mockResolvedValue(makeJob({ attempts: 1 }))
    handleJob.mockRejectedValue(floodError(15))
    rescheduleJob.mockRejectedValue(new Error('db down'))

    await processJob('job-1')

    // message re-flagged failed with a human reason, and job dead-lettered
    expect(setMessageStatus).toHaveBeenCalledWith('msg-1', 'failed', expect.stringContaining('флуд'))
    expect(finishJob).toHaveBeenCalledWith('job-1', false, null, 'FLOOD_WAIT_15')
  })
})
