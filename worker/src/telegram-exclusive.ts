import { TelegramClient, Api } from 'telegram'
import { logger } from './logger.js'
import { errMessage } from './telegram-errors.js'

/**
 * Exclusive-session enforcement: fetch every active Telegram authorization on
 * the account and terminate all of them except the current (worker) session.
 * Shared by the automatic periodic sweep, the instant reaction to
 * UpdateNewAuthorization, and the God-panel "kick now" job.
 *
 * NOTE: Telegram forbids terminating an authorization until it is ~24h old
 * (`FRESH_RESET_AUTHORISATION_FORBIDDEN`). A foreign client that JUST logged in
 * therefore can't always be killed on the spot — the periodic sweep keeps
 * retrying and removes it as soon as Telegram allows. This is a platform-side
 * protection we cannot bypass. Best-effort and fully non-fatal.
 */
export async function runKickSweep(
  client: TelegramClient | null,
  channelId: string,
): Promise<{ kicked: number; skipped: number }> {
  if (!client) return { kicked: 0, skipped: 0 }

  let kicked = 0
  let skipped = 0

  try {
    const res = await client.invoke(new Api.account.GetAuthorizations())
    const others = res.authorizations.filter((a) => !a.current)

    for (const auth of others) {
      try {
        await client.invoke(
          new Api.account.ResetAuthorization({ hash: auth.hash }),
        )
        kicked++
        logger.warn(
          {
            channelId,
            device: auth.deviceModel,
            platform: auth.platform,
            appName: auth.appName,
            ip: auth.ip,
            country: auth.country,
          },
          'Exclusive session: terminated a foreign Telegram authorization',
        )
      } catch (err) {
        // Most commonly FRESH_RESET_AUTHORISATION_FORBIDDEN for sessions <24h
        // old — expected; the periodic sweep will retry once it ages out.
        skipped++
        logger.warn(
          {
            channelId,
            device: auth.deviceModel,
            err: errMessage(err),
          },
          'Exclusive session: could not terminate a foreign authorization yet',
        )
      }
    }
  } catch (err) {
    logger.warn(
      { channelId, err: errMessage(err) },
      'Exclusive session: getAuthorizations failed (non-fatal)',
    )
  }

  return { kicked, skipped }
}
