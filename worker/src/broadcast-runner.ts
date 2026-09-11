import { logger } from './logger.js'
import { errMessage } from './telegram-errors.js'
import { TelegramSession } from './telegram.js'
import { varyForGroup } from './broadcast-draft.js'
import * as repo from './broadcast-repo.js'

/**
 * Broadcast runner tick. Called on an interval from index.ts. Processes AT MOST
 * ONE target per due campaign per tick, then parks the campaign for a
 * human-like delay — a personal account must never fire two sends back-to-back.
 *
 * Per target: join → pre-post captcha → post the per-group variant →
 * post-post captcha. Failures are classified:
 *   - FLOOD_WAIT            → park the whole campaign for the wait, requeue target
 *   - transient send error  → per-target backoff, requeue
 *   - needs a human         → target = needs_attention (no auto retry)
 *   - hard error            → target = failed
 * Too many consecutive campaign errors trips an auto-stop (status='failed').
 */

/** Stop the whole campaign after this many consecutive target errors. */
const MAX_CONSEC_ERRORS = 5
/** Give up on a single target after this many attempts. */
const MAX_TARGET_ATTEMPTS = 4
/** Pause between the join step and the first post (let the gate bot speak). */
const POST_JOIN_PAUSE_MS = 2500

export async function runBroadcastTick(
  getSession: (channelId: string) => unknown,
): Promise<void> {
  const campaigns = await repo.listDueCampaigns()
  for (const campaign of campaigns) {
    try {
      await processCampaign(campaign, getSession)
    } catch (err) {
      logger.error(
        { campaignId: campaign.id, err: errMessage(err) },
        'broadcast: campaign tick failed',
      )
    }
  }
}

async function processCampaign(
  campaign: repo.DueCampaign,
  getSession: (channelId: string) => unknown,
): Promise<void> {
  const session = getSession(campaign.channelId)
  if (!(session instanceof TelegramSession) || !session.personal) {
    // Account offline: park briefly and try again — not the target's fault.
    await repo.pushCampaignNotBefore(campaign.id, 30)
    return
  }

  const target = await repo.claimNextTarget(campaign.id)
  if (!target) {
    // Nothing due right now. If nothing will ever be due, finish the campaign.
    const unfinished = await repo.hasUnfinishedTargets(campaign.id)
    if (!unfinished) await repo.stopCampaign(campaign.id, 'done')
    else await repo.pushCampaignNotBefore(campaign.id, 15)
    return
  }

  const delay = pickDelaySec(campaign.minDelaySec, campaign.maxDelaySec)

  try {
    // 1. Join (resolves the entity, idempotent if already a member).
    const joined = await session.broadcastJoin(target.rawInput)
    await repo.markTargetResolved(target.id, joined.peerId, joined.title)

    // 2. Let the gate bot post its "ты не бот?" prompt, then answer it.
    await sleep(POST_JOIN_PAUSE_MS)
    await repo.setTargetStage(target.id, 'verifying')
    const pre = await session.broadcastCaptcha(joined.entity, campaign.captchaReply)
    if (pre === 'needs_human') {
      await repo.markTargetStuck(
        target.id,
        'needs_attention',
        'Требуется ручное прохождение проверки при вступлении',
      )
      await finishOk(campaign.id, delay)
      return
    }

    // 3. Post the per-group text variant (generated now if missing).
    await repo.setTargetStage(target.id, 'sending')
    const text = target.draftText?.trim()
      ? target.draftText
      : await varyForGroup(campaign.baseText, joined.title)
    await session.broadcastPost(joined.entity, text)

    // 4. Some gate bots re-challenge right after the first post.
    const post = await session.broadcastCaptcha(joined.entity, campaign.captchaReply)
    if (post === 'needs_human') {
      // The message likely went out; flag for a human to double-check.
      await repo.markTargetStuck(
        target.id,
        'needs_attention',
        'Сообщение отправлено, но после него бот снова запросил проверку',
      )
      await finishOk(campaign.id, delay)
      return
    }

    await repo.markTargetSent(target.id)
    await finishOk(campaign.id, delay)
  } catch (err) {
    await handleTargetError(campaign, target, err, delay)
  }
}

async function finishOk(campaignId: string, delaySec: number): Promise<void> {
  await repo.resetCampaignErrors(campaignId)
  await repo.pushCampaignNotBefore(campaignId, delaySec)
}

async function handleTargetError(
  campaign: repo.DueCampaign,
  target: repo.ClaimedTarget,
  err: unknown,
  delaySec: number,
): Promise<void> {
  const msg = errMessage(err)
  const floodWait = parseFloodWaitSec(msg)

  if (floodWait != null) {
    // Telegram told us exactly how long to wait: park the campaign for that
    // long plus a margin, and requeue this target (its attempt didn't "count").
    logger.warn(
      { campaignId: campaign.id, targetId: target.id, floodWait },
      'broadcast: FLOOD_WAIT, backing off',
    )
    await repo.requeueTarget(target.id, floodWait + 5, `FLOOD_WAIT ${floodWait}s`)
    await repo.pushCampaignNotBefore(campaign.id, floodWait + 5)
    return
  }

  if (isNeedsHuman(msg)) {
    await repo.markTargetStuck(target.id, 'needs_attention', humanReason(msg))
    await repo.pushCampaignNotBefore(campaign.id, delaySec)
    return
  }

  if (isHardFailure(msg) || target.attempts >= MAX_TARGET_ATTEMPTS) {
    await repo.markTargetStuck(target.id, 'failed', msg)
  } else {
    // Transient — per-target backoff grows with attempts.
    await repo.requeueTarget(target.id, delaySec * target.attempts, msg)
  }

  const consec = await repo.bumpCampaignErrors(campaign.id, msg)
  if (consec >= MAX_CONSEC_ERRORS) {
    logger.error(
      { campaignId: campaign.id, consec },
      'broadcast: too many consecutive errors, auto-stopping',
    )
    await repo.stopCampaign(
      campaign.id,
      'failed',
      `Авто-стоп после ${consec} ошибок подряд. Последняя: ${msg}`,
    )
  } else {
    await repo.pushCampaignNotBefore(campaign.id, delaySec)
  }
}

/* -------------------------------- Helpers --------------------------------- */

/** Uniform random delay in [min, max] seconds (human-like pacing). */
function pickDelaySec(min: number, max: number): number {
  const lo = Math.max(1, Math.min(min, max))
  const hi = Math.max(lo, Math.max(min, max))
  return lo + Math.floor(Math.random() * (hi - lo + 1))
}

/** Extract N from "FLOOD_WAIT_123" / "A wait of 123 seconds is required". */
function parseFloodWaitSec(msg: string): number | null {
  const m = msg.match(/FLOOD_WAIT_(\d+)/i) || msg.match(/wait of (\d+) seconds/i)
  if (m) return Number(m[1])
  return null
}

/** Errors that mean "a real person must act" rather than a code retry. */
function isNeedsHuman(msg: string): boolean {
  return /NEEDS_APPROVAL|INVITE_REQUEST_SENT|CHANNELS_TOO_MUCH|CHAT_ADMIN_REQUIRED/i.test(
    msg,
  )
}

function humanReason(msg: string): string {
  if (/NEEDS_APPROVAL|INVITE_REQUEST_SENT/i.test(msg))
    return 'Заявка на вступление отправлена — ждёт одобрения модератора'
  if (/CHANNELS_TOO_MUCH/i.test(msg))
    return 'Аккаунт состоит в слишком многих группах (лимит Telegram)'
  return msg
}

/** Permanent errors — no point retrying this target. */
function isHardFailure(msg: string): boolean {
  return /USERNAME_INVALID|USERNAME_NOT_OCCUPIED|INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|CHANNEL_PRIVATE|CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|BAD_TARGET_FORMAT|EMPTY_TARGET|PEER_ID_INVALID|CHANNEL_INVALID/i.test(
    msg,
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
