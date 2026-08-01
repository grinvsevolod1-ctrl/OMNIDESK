import type { TelegramClient, Api } from 'telegram'
import type { SenderSession } from './autopilot.js'

/**
 * The narrow view of a live TelegramSession that the split-out feature modules
 * (history sync, live-update handlers, media/sticker IO) operate on. They used
 * to be private methods of the 1400-line TelegramSession class; extracting them
 * as functions over this context keeps each concern in its own file WITHOUT
 * giving any module access to login state (phone, phoneCodeHash, session
 * string) — only the class itself can touch those.
 *
 * Everything is expressed as accessors rather than captured values on purpose:
 * the client can disconnect mid-sweep and ingest can be paused at any moment,
 * so modules must re-read live state at each checkpoint exactly like the
 * original `this.client` / `this.ingestPaused` checks did.
 */
export interface TgSessionCtx {
  readonly channelId: string
  readonly managerId: string
  /** Live client or null when stopped/never started. Re-read at checkpoints. */
  getClient(): TelegramClient | null
  /** Soft pause: connected but not writing inbound to the inbox. */
  isIngestPaused(): boolean
  /** Download + persist media bytes from a message we already hold. */
  persistMediaBytes(messageId: string | null, msg: Api.Message): Promise<void>
  /** Turn a stored contact_handle back into something GramJS can send to. */
  resolveTarget(target: string): Promise<Api.TypeInputPeer | string>
  /** Re-import dialogs (also repopulates the entity/peer caches). */
  syncDialogs(opts?: { backfill?: boolean }): Promise<void>
  /** Kick foreign authorizations — the instant reaction path. */
  enforceExclusiveSessions(): Promise<void>
  /** Per-account send pacing shared by text sends and stickers. */
  throttleSend(): Promise<void>
  /** The session object handed to the autopilot as its SenderSession. */
  readonly senderSession: SenderSession
}
