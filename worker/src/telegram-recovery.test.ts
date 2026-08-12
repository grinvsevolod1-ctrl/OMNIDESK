import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Delivery-recovery sweep tests with mocked repo + client.
 *
 * The sweep decides whether a message written while the account was offline
 * gets resent, backfilled (already delivered — duplicate guard), or marked
 * failed with the right reason. Wrong decisions here mean clients receive
 * the same message twice or never — so every branch runs the real production
 * code with only the edges (repo, GramJS client) replaced.
 * telegram-errors.js is intentionally REAL: classification is part of the
 * behavior under test.
 */

vi.mock('telegram', () => ({
  TelegramClient: class {},
  Api: {},
}))

vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('./repo.js', () => ({
  listRecoverableOutbound: vi.fn(async () => []),
  setMessageProviderId: vi.fn(async () => {}),
  setMessageStatus: vi.fn(async () => {}),
}))

import {
  recoverUndeliveredOutbound,
  type TelegramRecoveryDeps,
} from './telegram-recovery.js'
import { OFFLINE_SEND_REASON } from './telegram-errors.js'
import * as repo from './repo.js'

const listRecoverable = vi.mocked(repo.listRecoverableOutbound)
const setProviderId = vi.mocked(repo.setMessageProviderId)
const setStatus = vi.mocked(repo.setMessageStatus)

/** Client stub: recovery only calls getMessages for the duplicate guard. */
function makeClient(recentOutbound: Array<{ message: string; id: number }> = []) {
  return {
    getMessages: vi.fn(async () =>
      recentOutbound.map((m) => ({ out: true, message: m.message, id: m.id })),
    ),
  }
}

function makeDeps(overrides?: Partial<TelegramRecoveryDeps>) {
  const client = makeClient()
  const deps: TelegramRecoveryDeps = {
    channelId: 'ch-1',
    getClient: () => client as never,
    resolveTarget: vi.fn(async (t: string) => t),
    sendMessage: vi.fn(async () => ({ providerMessageId: 'pm-99' })),
    ...overrides,
  }
  return { deps, client }
}

beforeEach(() => {
  vi.clearAllMocks()
  listRecoverable.mockResolvedValue([])
})

describe('recoverUndeliveredOutbound', () => {
  it('does nothing when there are no recoverable messages', async () => {
    const { deps } = makeDeps()
    await recoverUndeliveredOutbound(deps)
    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(setStatus).not.toHaveBeenCalled()
  })

  it('resends a pending message and backfills provider id + sent status', async () => {
    listRecoverable.mockResolvedValue([
      { id: 'm-1', body: 'привет', contactHandle: '@user' },
    ])
    const { deps } = makeDeps()

    await recoverUndeliveredOutbound(deps)

    expect(deps.sendMessage).toHaveBeenCalledWith('@user', 'привет')
    expect(setProviderId).toHaveBeenCalledWith('m-1', 'pm-99')
    expect(setStatus).toHaveBeenCalledWith('m-1', 'sent', null)
  })

  it('duplicate guard: identical text already in recent outbound → backfill, NO resend', async () => {
    listRecoverable.mockResolvedValue([
      { id: 'm-1', body: 'уже дошло', contactHandle: '@user' },
    ])
    const client = makeClient([{ message: 'уже дошло', id: 4242 }])
    const { deps } = makeDeps({ getClient: () => client as never })

    await recoverUndeliveredOutbound(deps)

    expect(deps.sendMessage).not.toHaveBeenCalled()
    expect(setProviderId).toHaveBeenCalledWith('m-1', '4242')
    expect(setStatus).toHaveBeenCalledWith('m-1', 'sent', null)
  })

  it('keeps the OFFLINE marker on a transport failure so the NEXT reconnect retries', async () => {
    listRecoverable.mockResolvedValue([
      { id: 'm-1', body: 'x', contactHandle: '@user' },
    ])
    const { deps } = makeDeps({
      sendMessage: vi.fn(async () => {
        throw new Error('Cannot send requests while disconnected')
      }),
    })

    await recoverUndeliveredOutbound(deps)

    expect(setStatus).toHaveBeenCalledWith('m-1', 'failed', OFFLINE_SEND_REASON)
  })

  it('records the real reason on a genuine provider rejection (no more retries)', async () => {
    listRecoverable.mockResolvedValue([
      { id: 'm-1', body: 'x', contactHandle: '@user' },
    ])
    const { deps } = makeDeps({
      sendMessage: vi.fn(async () => {
        throw new Error('USER_IS_BLOCKED')
      }),
    })

    await recoverUndeliveredOutbound(deps)

    expect(setStatus).toHaveBeenCalledOnce()
    const [id, status, reason] = setStatus.mock.calls[0]
    expect(id).toBe('m-1')
    expect(status).toBe('failed')
    expect(reason).not.toBe(OFFLINE_SEND_REASON)
    expect(typeof reason).toBe('string')
  })

  it('stops the sweep when the client disconnects mid-way (rest retried next login)', async () => {
    listRecoverable.mockResolvedValue([
      { id: 'm-1', body: 'a', contactHandle: '@u1' },
      { id: 'm-2', body: 'b', contactHandle: '@u2' },
    ])
    // Client vanishes after the first send.
    let client: unknown = makeClient()
    const { deps } = makeDeps({
      getClient: () => client as never,
      sendMessage: vi.fn(async () => {
        client = null
        return { providerMessageId: 'pm-1' }
      }),
    })

    await recoverUndeliveredOutbound(deps)

    expect(deps.sendMessage).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledTimes(1)
    expect(setStatus).toHaveBeenCalledWith('m-1', 'sent', null)
  })

  it('one failed message never aborts the rest of the sweep', async () => {
    listRecoverable.mockResolvedValue([
      { id: 'm-1', body: 'a', contactHandle: '@u1' },
      { id: 'm-2', body: 'b', contactHandle: '@u2' },
    ])
    const send = vi
      .fn(async () => ({ providerMessageId: 'pm-2' }))
      .mockRejectedValueOnce(new Error('USER_IS_BLOCKED'))
    const { deps } = makeDeps({ sendMessage: send })

    await recoverUndeliveredOutbound(deps)

    expect(send).toHaveBeenCalledTimes(2)
    expect(setStatus).toHaveBeenCalledWith('m-2', 'sent', null)
  })
})
