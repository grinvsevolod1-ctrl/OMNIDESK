import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Login-flow state machine tests with a mocked GramJS client.
 *
 * The worker's most dangerous code path (phone login → code → 2FA) had no
 * test coverage because it talks to live Telegram. Here the network edge is
 * replaced entirely: `client.invoke`/`sendCode` are `vi.fn()`s, the `teleproto`
 * package is mocked with minimal stand-in classes, and repo/env are stubbed.
 * What IS real is the TelegramPhoneLogin state machine itself — every status
 * transition, callback hand-off and error branch runs the production code.
 */

// ---- module mocks (hoisted by vitest; factories must be self-contained) ----

vi.mock('teleproto', () => {
  class SignIn {
    constructor(public args: Record<string, unknown>) {}
  }
  class GetPassword {}
  class CheckPassword {
    constructor(public args: Record<string, unknown>) {}
  }
  return {
    TelegramClient: class {},
    Api: {
      auth: { SignIn, CheckPassword },
      account: { GetPassword },
    },
  }
})

vi.mock('teleproto/sessions/index.js', () => ({
  StringSession: class {
    constructor(public saved: string) {}
  },
}))

vi.mock('teleproto/Password.js', () => ({
  computeCheck: vi.fn(async () => ({ srp: 'check' })),
}))

vi.mock('./env.js', () => ({
  env: { telegramApiId: 12345, telegramApiHash: 'hash', authDebug: false },
}))

vi.mock('./repo.js', () => ({
  setSession: vi.fn(async () => {}),
  getTgSession: vi.fn(async () => ''),
  getProxyForChannel: vi.fn(async () => null),
  mergeChannelConfig: vi.fn(async () => {}),
}))

import { TelegramPhoneLogin, type PhoneLoginDeps } from './telegram-phone-login.js'
import * as repo from './repo.js'

// ---- test harness -----------------------------------------------------------

/** Minimal fake of the GramJS client surface the login flow touches. */
function makeFakeClient() {
  return {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    checkAuthorization: vi.fn(async () => false),
    sendCode: vi.fn(async () => ({ phoneCodeHash: 'pch-1', isCodeViaApp: true })),
    invoke: vi.fn(async () => ({})),
  }
}
type FakeClient = ReturnType<typeof makeFakeClient>

const noopLog = () => {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
  // authLogger() returns a pino Logger; the flow only calls these four.
  return log as unknown as ReturnType<PhoneLoginDeps['authLogger']>
}

function makeHarness(client: FakeClient = makeFakeClient()) {
  let current: FakeClient | null = null
  const deps = {
    channelId: 'ch-1',
    authLogger: noopLog,
    setAttemptId: vi.fn(),
    clearLoginTimer: vi.fn(),
    armLoginTimer: vi.fn(),
    clearQr: vi.fn(),
    getClient: () => current as never,
    setClient: (c: unknown) => {
      current = c as FakeClient | null
    },
    setSession: vi.fn(),
    buildClient: vi.fn(async () => client as never),
    persist: vi.fn(async () => {}),
    afterLogin: vi.fn(async () => {}),
    fail: vi.fn(async () => ({ sessionStatus: 'error' as const })),
    notStarted: vi.fn(async () => ({ sessionStatus: 'error' as const })),
  } satisfies PhoneLoginDeps
  return { flow: new TelegramPhoneLogin(deps), deps, client }
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---- start() ---------------------------------------------------------------

describe('TelegramPhoneLogin.start', () => {
  it('resumes straight to online when a saved session is already authorized', async () => {
    const client = makeFakeClient()
    client.checkAuthorization.mockResolvedValue(true)
    const { flow, deps } = makeHarness(client)

    const res = await flow.start()

    expect(res.sessionStatus).toBe('online')
    expect(deps.afterLogin).toHaveBeenCalledOnce()
    expect(client.sendCode).not.toHaveBeenCalled()
  })

  it('requests a code and lands in code_pending when a phone is provided', async () => {
    const { flow, deps, client } = makeHarness()

    const res = await flow.start('+79990001122', 'attempt-1')

    expect(res.sessionStatus).toBe('code_pending')
    expect(deps.setAttemptId).toHaveBeenCalledWith('attempt-1')
    // A fresh start supersedes any pending QR and abandonment timer.
    expect(deps.clearQr).toHaveBeenCalledOnce()
    expect(deps.clearLoginTimer).toHaveBeenCalledOnce()
    expect(client.sendCode).toHaveBeenCalledOnce()
    // The DC-correct session must be persisted so a worker restart can resume.
    expect(deps.persist).toHaveBeenCalledOnce()
    // Delivery branch (app vs sms) is recorded for the connect wizard.
    expect(repo.mergeChannelConfig).toHaveBeenCalledWith('ch-1', {
      codeDelivery: 'app',
    })
    expect(repo.setSession).toHaveBeenCalledWith('ch-1', 'code_pending')
    expect(deps.armLoginTimer).toHaveBeenCalledOnce()
  })

  it('errors out when not authorized and no phone was provided', async () => {
    const { flow, deps } = makeHarness()

    const res = await flow.start()

    expect(res.sessionStatus).toBe('error')
    expect(repo.setSession).toHaveBeenCalledWith(
      'ch-1',
      'error',
      expect.objectContaining({ lastError: expect.stringContaining('Phone number required') }),
    )
    expect(deps.afterLogin).not.toHaveBeenCalled()
  })

  it('routes connect() failures through the shared fail path', async () => {
    const client = makeFakeClient()
    client.connect.mockRejectedValue(new Error('PROXY_DEAD'))
    const { flow, deps } = makeHarness(client)

    const res = await flow.start('+79990001122')

    expect(deps.fail).toHaveBeenCalledOnce()
    expect(res.sessionStatus).toBe('error')
  })

  it('tears down a previous half-logged-in client before rebuilding', async () => {
    const stale = makeFakeClient()
    const { flow, deps } = makeHarness()
    deps.setClient(stale as never)

    await flow.start('+79990001122')

    expect(stale.disconnect).toHaveBeenCalledOnce()
    expect(deps.buildClient).toHaveBeenCalledOnce()
  })

  it('records sms delivery when Telegram does not use in-app codes', async () => {
    const client = makeFakeClient()
    client.sendCode.mockResolvedValue({ phoneCodeHash: 'pch-2', isCodeViaApp: false })
    const { flow } = makeHarness(client)

    await flow.start('+79990001122')

    expect(repo.mergeChannelConfig).toHaveBeenCalledWith('ch-1', {
      codeDelivery: 'sms',
    })
  })
})

// ---- submitCode() ------------------------------------------------------------

describe('TelegramPhoneLogin.submitCode', () => {
  /** Drive a real start() so phone + phoneCodeHash are held in the machine. */
  async function startedFlow() {
    const harness = makeHarness()
    await harness.flow.start('+79990001122')
    vi.clearAllMocks()
    return harness
  }

  it('goes online when Telegram accepts the code', async () => {
    const { flow, deps, client } = await startedFlow()

    const res = await flow.submitCode('12345')

    expect(res.sessionStatus).toBe('online')
    expect(deps.afterLogin).toHaveBeenCalledOnce()
    // The SignIn invoke must carry the phone and hash from the start() step.
    const arg = (client.invoke.mock.calls as unknown[][])[0][0] as {
      args: Record<string, unknown>
    }
    expect(arg.args.phoneNumber).toBe('+79990001122')
    expect(arg.args.phoneCodeHash).toBe('pch-1')
    expect(arg.args.phoneCode).toBe('12345')
  })

  it('transitions to password_pending on SESSION_PASSWORD_NEEDED (2FA)', async () => {
    const { flow, deps, client } = await startedFlow()
    client.invoke.mockRejectedValue(new Error('SESSION_PASSWORD_NEEDED'))

    const res = await flow.submitCode('12345')

    expect(res.sessionStatus).toBe('password_pending')
    expect(repo.setSession).toHaveBeenCalledWith('ch-1', 'password_pending')
    // Waiting on the cloud password now — abandonment timer must be re-armed.
    expect(deps.armLoginTimer).toHaveBeenCalledOnce()
    expect(deps.fail).not.toHaveBeenCalled()
  })

  it('routes a rejected code through the shared fail path', async () => {
    const { flow, deps, client } = await startedFlow()
    client.invoke.mockRejectedValue(new Error('PHONE_CODE_INVALID'))

    const res = await flow.submitCode('00000')

    expect(deps.fail).toHaveBeenCalledOnce()
    expect(res.sessionStatus).toBe('error')
  })

  it('reports notStarted when no client exists', async () => {
    const { flow, deps } = makeHarness()

    await flow.submitCode('12345')

    expect(deps.notStarted).toHaveBeenCalledOnce()
  })

  it('errors with a clear message when phoneCodeHash was lost (worker restart)', async () => {
    const { flow, deps } = makeHarness()
    // Client exists (session restored) but the in-memory hash is gone.
    deps.setClient(makeFakeClient() as never)

    const res = await flow.submitCode('12345')

    expect(res.sessionStatus).toBe('error')
    expect(repo.setSession).toHaveBeenCalledWith(
      'ch-1',
      'error',
      expect.objectContaining({ lastError: expect.stringContaining('worker restarted') }),
    )
  })
})

// ---- submitPassword() ---------------------------------------------------------

describe('TelegramPhoneLogin.submitPassword', () => {
  it('goes online when the SRP check passes', async () => {
    const { flow, deps } = makeHarness()
    deps.setClient(makeFakeClient() as never)

    const res = await flow.submitPassword('secret')

    expect(res.sessionStatus).toBe('online')
    expect(deps.afterLogin).toHaveBeenCalledOnce()
  })

  it('routes a rejected password through the shared fail path', async () => {
    const client = makeFakeClient()
    client.invoke.mockRejectedValue(new Error('PASSWORD_HASH_INVALID'))
    const { flow, deps } = makeHarness()
    deps.setClient(client as never)

    const res = await flow.submitPassword('wrong')

    expect(deps.fail).toHaveBeenCalledOnce()
    expect(res.sessionStatus).toBe('error')
  })

  it('reports notStarted when no client exists', async () => {
    const { flow, deps } = makeHarness()

    await flow.submitPassword('secret')

    expect(deps.notStarted).toHaveBeenCalledOnce()
  })
})
