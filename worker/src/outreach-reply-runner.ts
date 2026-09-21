import { logger } from './logger.js'
import {
  listOpenOutreachThreads,
  ingestOutreachReply,
  type OutreachOpenThreadRow,
} from './repo-outreach.js'

/**
 * Outreach reply poller (item 2 — inbound capture).
 *
 * The outbound contour deliberately does NOT ingest dialogs into the seller
 * inbox: the account pool is driven in personal (stateless) mode, exactly like
 * god-panel personal accounts. So a lead's reply never arrives through the
 * normal update pipeline. This runner closes that gap: for every open thread
 * (a lead that was messaged and isn't closed) it pulls a small live history
 * page from MTProto and appends anything the lead sent since we last looked.
 *
 * Idempotency lives in the DB (ingestOutreachReply → ON CONFLICT on
 * (lead_id, provider_msg_id)), so re-polling the same page never double-stores.
 * The manager view's 15s SWR poll then surfaces the reply — no push needed.
 *
 * Best-effort throughout: an offline session or a resolve failure is skipped,
 * never fatal.
 */

/** Minimal session surface this runner needs (satisfied by TelegramSession). */
export interface ReplyPollSession {
  personalHistory(
    peer: string,
    opts?: { beforeId?: number; limit?: number },
  ): Promise<
    Array<{ id: string; outgoing: boolean; text: string; date: number }>
  >
}

const BATCH = 40
const HISTORY_PAGE = 8

let inFlight = false

export async function runOutreachReplyTick(
  getSession: (channelId: string) => ReplyPollSession | undefined,
): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    const threads = await listOpenOutreachThreads(BATCH)
    for (const t of threads) {
      try {
        await pollThread(t, getSession)
      } catch (err) {
        logger.warn(
          { leadId: t.lead_id, err },
          'outreach reply poll failed for thread (non-fatal)',
        )
      }
    }
  } catch (err) {
    logger.error({ err }, 'outreach reply sweep failed')
  } finally {
    inFlight = false
  }
}

async function pollThread(
  t: OutreachOpenThreadRow,
  getSession: (channelId: string) => ReplyPollSession | undefined,
): Promise<void> {
  if (!t.target) return
  const session = getSession(t.channel_id)
  if (!session) return // account offline — try next tick

  const page = await session.personalHistory(t.target, { limit: HISTORY_PAGE })
  if (!page.length) return

  // Only inbound (their) text messages newer than the last one we stored.
  const lastSeen = t.last_in_provider_msg_id
    ? Number(t.last_in_provider_msg_id)
    : 0
  const fresh = page
    .filter((m) => !m.outgoing && Number(m.id) > lastSeen && m.text.trim())
    .sort((a, b) => Number(a.id) - Number(b.id))

  for (const m of fresh) {
    await ingestOutreachReply({
      leadId: t.lead_id,
      accountId: t.account_id,
      providerMsgId: m.id,
      body: m.text,
    })
  }
  if (fresh.length) {
    logger.info(
      { leadId: t.lead_id, count: fresh.length },
      'ingested outreach replies',
    )
  }
}
