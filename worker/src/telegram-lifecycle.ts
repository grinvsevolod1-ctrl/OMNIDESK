import { Api } from 'telegram'
import type { TelegramClient } from 'telegram'
import type { Logger } from 'pino'

import { logger } from './logger.js'
import * as repo from './repo.js'
import {
  classifyError,
  errMessage,
  extractErrorCode,
} from './telegram-errors.js'
import { attachTelegramHandlers } from './telegram-updates.js'
import type { TgSessionCtx } from './telegram-session-ctx.js'

/**
 * The narrow view of TelegramSession the lifecycle transitions operate on.
 * Accessors re-read live state; mutators hand state back so client/session
 * ownership never leaves the class (same contract as the other split-out
 * telegram-* modules).
 */
export interface TgLifecycleDeps {
  channelId: string
  ctx: TgSessionCtx
  getClient: () => TelegramClient | null
  setClient: (client: TelegramClient | null) => void
  authLogger: () => Logger
  persist: () => Promise<void>
  clearLoginTimer: () => void
  clearQr: () => void
  startExclusiveTimer: () => void
  stopExclusiveTimer: () => void
  startHealth: () => void
  stopHealth: () => void
  enforceExclusiveSessions: () => Promise<void>
  syncDialogs: (opts?: { backfill?: boolean }) => Promise<void>
  recoverUndeliveredOutbound: () => Promise<void>
}

/**
 * Post-login bring-up, extracted verbatim from TelegramSession.afterLogin():
 * persist the session string, resolve the account's display detail, attach
 * live-update handlers, mark the channel online, then kick off the background
 * housekeeping (exclusive-session sweep, health probe, dialog sync with
 * backfill, undelivered-outbound recovery).
 *
 * Gap recovery note: GramJS's client.catchUp() is an unimplemented stub
 * (function body is literally `// TODO`), so updates.getDifference cannot be
 * leaned on. The offline gap is recovered by the dialog sync: per-chat
 * watermarks (scripts/105) make it fetch ONLY the messages missed while
 * offline, not the whole history.
 */
export async function bringSessionOnline(deps: TgLifecycleDeps): Promise<void> {
  const client = deps.getClient()
  if (!client) return
  deps.clearLoginTimer()
  await deps.persist()
  try {
    const me = (await client.getMe()) as Api.User
    const handle = me.username
      ? `@${me.username}`
      : me.phone
        ? `+${me.phone}`
        : 'telegram'
    const name = [me.firstName, me.lastName].filter(Boolean).join(' ')
    await repo.setChannelDetail(deps.channelId, name || handle)
  } catch {
    /* non-fatal */
  }
  attachTelegramHandlers(deps.ctx)
  await repo.setSession(deps.channelId, 'online', { markConnected: true })
  logger.info({ channelId: deps.channelId }, 'Telegram session online')
  // Exclusive-session control: immediately terminate any OTHER active
  // authorizations, then keep enforcing on a periodic sweep. Background, so
  // going "online" isn't blocked by the account.getAuthorizations round-trip.
  void deps.enforceExclusiveSessions()
  deps.startExclusiveTimer()
  // Zombie detection: probe the connection on a fixed cadence so a dead
  // transport is noticed within minutes, not on the next failed send.
  deps.startHealth()
  // Import existing chats (with recent history backfill) so the inbox isn't
  // empty after connecting. Background: online isn't blocked by the fetch.
  void deps.syncDialogs({ backfill: true })
  // Delivery recovery: resend outbound messages written while disconnected.
  void deps.recoverUndeliveredOutbound()
}

/**
 * Zombie-connection teardown, invoked by the health monitor after two
 * consecutive failed pings: mark degraded and drop the client so revival
 * rebuilds a fresh connection instead of reusing the dead transport.
 */
export async function teardownZombieConnection(
  deps: TgLifecycleDeps,
): Promise<void> {
  deps.stopHealth()
  deps.stopExclusiveTimer()
  try {
    await deps.getClient()?.disconnect()
  } catch {
    /* transport already dead */
  }
  deps.setClient(null)
  await repo
    .setSession(deps.channelId, 'error', {
      lastError: 'Соединение с Telegram перестало отвечать (health ping)',
    })
    .catch(() => {})
}

/** Graceful stop: keep the authorization, just go offline. */
export async function stopSession(deps: TgLifecycleDeps): Promise<void> {
  deps.stopExclusiveTimer()
  deps.stopHealth()
  deps.clearLoginTimer()
  deps.clearQr()
  try {
    await deps.getClient()?.disconnect()
  } finally {
    deps.setClient(null)
    await repo.setSession(deps.channelId, 'offline')
  }
}

/** Full logout: revoke the authorization and wipe stored secrets. */
export async function logoutSession(deps: TgLifecycleDeps): Promise<void> {
  deps.stopExclusiveTimer()
  deps.stopHealth()
  deps.clearLoginTimer()
  deps.clearQr()
  try {
    await deps.getClient()?.invoke(new Api.auth.LogOut())
  } catch {
    /* ignore */
  }
  try {
    await deps.getClient()?.disconnect()
  } catch {
    /* ignore */
  }
  deps.setClient(null)
  await repo.clearSecrets(deps.channelId)
  await repo.setSession(deps.channelId, 'logged_out')
}

/** Shared login-failure path: classify, log, persist the error status. */
export async function failLogin(
  deps: Pick<TgLifecycleDeps, 'channelId' | 'authLogger'>,
  e: unknown,
): Promise<{ sessionStatus: repo.SessionStatus }> {
  const msg = errMessage(e)
  deps.authLogger().error(
    {
      stage: 'failure',
      category: classifyError(msg),
      errorCode: extractErrorCode(e),
      err: msg,
    },
    'TG login: failed',
  )
  await repo.setSession(deps.channelId, 'error', { lastError: msg })
  return { sessionStatus: 'error' }
}
