import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * QR-login state machine tests with a mocked GramJS client.
 *
 * Same harness philosophy as telegram-phone-login.test.ts: the network edge
 * (`client.invoke`, `_switchDC`) is faked, the mocked `telegram` module
 * provides real classes so `instanceof` checks in the production code work,
 * and the TelegramQrLogin machine itself runs for real — token export,
 * scan finalize, DC migration, and the 2FA hand-off.
 */

vi.mock('telegram', () => {
  class LoginToken {
    token: Buffer
    expires: number
    constructor(args: { token: Buffer; expires: number }) {
      this.token = args.token
      this.expires = args.expires
    }
  }
  class LoginTokenSuccess {}
  class LoginTokenMigrateTo {
    dcId: number
    token: Buffer
    constructor(args: { dcId: number; token: Buffer }) {
      this.dcId = args.dcId
      this.token = args.token
    }
  }
  class ExportLoginToken {
    constructor(public args: Record<string, unknown>) {}
  }
  class ImportLoginToken {
    constructor(public args: Record<string, unknown>) {}
  }
  class UpdateLoginToken {}
  return {
    TelegramClient: class {},
    Api: {
      UpdateLoginToken,
      auth: {
        ExportLoginToken,
        ImportLoginToken,
        LoginToken,
        LoginTokenSuccess,
        LoginTokenMigrateTo,
      },
    },
  }
})

vi.mock('./env.js', () => ({
  env: { telegramApiId: 12345, telegramApiHash: 'hash', authDebug: false },
}))

vi.mock('./repo.js', () => ({
  setSession: vi.fn(async () => {}),
}))

import { Api } from 'telegram'
import { TelegramQrLogin, type QrLoginDeps } from './telegram-qr-login.js'
import * as repo from './repo.js'

// ---- harness ----------------------------------------------------------------

function makeFakeClient() {
  return {
    // The request parameter matters: mock.calls derives its tuple type from
    // this signature, and the DC-migration test inspects calls[1][0].
    invoke: vi.fn(async (_req: unknown): Promise<unknown> => ({})),
    addEventHandler: vi.fn(),
    removeEventHandler: vi.fn(),
    _switchDC: vi.fn(async () => {}),
  }
}

/**
 * The runtime class is our arg-less mock, but TypeScript sees the real GramJS
 * constructor which demands an `authorization` payload — bypass it via cast.
 */
function loginSuccess(): InstanceType<typeof Api.auth.LoginTokenSuccess> {
  const Ctor = Api.auth.LoginTokenSuccess as unknown as new () => InstanceType<
    typeof Api.auth.LoginTokenSuccess
  >
  return new Ctor()
}
type FakeClient = ReturnType<typeof makeFakeClient>

const noopLog = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }) as unknown as ReturnType<QrLoginDeps['authLogger']>

function makeHarness(client: FakeClient | null = makeFakeClient()) {
  const deps: QrLoginDeps = {
    channelId: 'ch-1',
    getClient: () => client as never,
    authLogger: noopLog,
    armLoginTimer: vi.fn(),
    afterLogin: vi.fn(async () => {}),
    fail: vi.fn(async () => ({ sessionStatus: 'error' as const })),
    resetForNewAuth: vi.fn(async () => {}),
    clearLoginTimer: vi.fn(),
    setAttemptId: vi.fn(),
  }
  return { qr: new TelegramQrLogin(deps), deps, client }
}

function freshToken(expiresInSec = 30) {
  return new Api.auth.LoginToken({
    token: Buffer.from('tok-1'),
    expires: Math.floor(Date.now() / 1000) + expiresInSec,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ---- exportToken -------------------------------------------------------------

describe('TelegramQrLogin.exportToken', () => {
  it('returns qr_pending with a tg://login deep link for a fresh token', async () => {
    const { qr, client } = makeHarness()
    client!.invoke.mockResolvedValue(freshToken())

    const status = await qr.exportToken()

    expect(status).toBe('qr_pending')
    const current = qr.current()
    expect(current?.url).toMatch(/^tg:\/\/login\?token=/)
    expect(current!.expiresAt).toBeGreaterThan(Date.now())
    qr.clear() // drop the refresh timer so the test process exits cleanly
  })

  it('completes login when Telegram reports the token already consumed', async () => {
    const { qr, deps, client } = makeHarness()
    client!.invoke.mockResolvedValue(loginSuccess())

    const status = await qr.exportToken()

    expect(status).toBe('online')
    expect(deps.afterLogin).toHaveBeenCalledOnce()
    expect(qr.current()).toBeNull() // clear() ran as part of completion
  })

  it('returns error when the client is gone', async () => {
    const { qr } = makeHarness(null)
    expect(await qr.exportToken()).toBe('error')
  })
})

// ---- DC migration -------------------------------------------------------------

describe('TelegramQrLogin DC migration', () => {
  it('switches DC, imports the token and goes online', async () => {
    const { qr, deps, client } = makeHarness()
    client!.invoke
      .mockResolvedValueOnce(
        new Api.auth.LoginTokenMigrateTo({ dcId: 4, token: Buffer.from('t') }),
      )
      .mockResolvedValueOnce(loginSuccess())

    const status = await qr.exportToken()

    expect(status).toBe('online')
    expect(client!._switchDC).toHaveBeenCalledWith(4)
    const importCall = client!.invoke.mock.calls[1][0]
    expect(importCall).toBeInstanceOf(Api.auth.ImportLoginToken)
    expect(deps.afterLogin).toHaveBeenCalledOnce()
  })

  it('fails loudly when _switchDC disappears after a library upgrade', async () => {
    const { qr, deps, client } = makeHarness()
    client!.invoke.mockResolvedValue(
      new Api.auth.LoginTokenMigrateTo({ dcId: 4, token: Buffer.from('t') }),
    )
    ;(client as unknown as { _switchDC: unknown })._switchDC = undefined

    const status = await qr.exportToken()

    expect(status).toBe('error')
    expect(deps.fail).toHaveBeenCalledOnce()
    expect(deps.afterLogin).not.toHaveBeenCalled()
  })
})

// ---- 2FA hand-off -------------------------------------------------------------

describe('TelegramQrLogin 2FA', () => {
  it('hands off to password_pending when the account has a cloud password', async () => {
    const { qr, deps, client } = makeHarness()
    client!.invoke
      .mockResolvedValueOnce(
        new Api.auth.LoginTokenMigrateTo({ dcId: 4, token: Buffer.from('t') }),
      )
      .mockRejectedValueOnce(new Error('SESSION_PASSWORD_NEEDED'))

    const status = await qr.exportToken()

    expect(status).toBe('password_pending')
    expect(repo.setSession).toHaveBeenCalledWith('ch-1', 'password_pending')
    expect(deps.armLoginTimer).toHaveBeenCalledOnce()
    expect(deps.fail).not.toHaveBeenCalled()
  })
})

// ---- scan listener -------------------------------------------------------------

describe('TelegramQrLogin scan listener', () => {
  it('finalizes the login when UpdateLoginToken arrives', async () => {
    const { qr, deps, client } = makeHarness()
    // finalize() re-exports: consumed token → complete → online.
    client!.invoke.mockResolvedValue(loginSuccess())

    qr.attachScanListener()
    expect(client!.addEventHandler).toHaveBeenCalledOnce()
    const handler = client!.addEventHandler.mock.calls[0][0] as (
      u: unknown,
    ) => void

    handler(new Api.UpdateLoginToken())
    await vi.waitFor(() => expect(deps.afterLogin).toHaveBeenCalledOnce())
  })

  it('ignores unrelated updates', async () => {
    const { qr, client } = makeHarness()
    qr.attachScanListener()
    const handler = client!.addEventHandler.mock.calls[0][0] as (
      u: unknown,
    ) => void

    handler({ className: 'UpdateNewMessage' })

    expect(client!.invoke).not.toHaveBeenCalled()
  })

  it('clear() detaches the listener and drops the pending QR', async () => {
    const { qr, client } = makeHarness()
    client!.invoke.mockResolvedValue(freshToken())
    await qr.exportToken()
    qr.attachScanListener()

    qr.clear()

    expect(qr.current()).toBeNull()
    expect(client!.removeEventHandler).toHaveBeenCalledOnce()
  })
})
