import { logger } from './logger.js'
import {
  claimWarmupCandidates,
  bumpWarmupDay,
  markAccountAction,
  getOutreachSetting,
  listWarmPeers,
  type OutreachAccountRow,
} from './repo-outreach.js'

/** Minimal session surface for mutual warming (satisfied by TelegramSession). */
export interface WarmSendSession {
  personalStartDialog(
    target: string,
    text: string,
  ): Promise<{ peerId: string }>
}

/** Short, human, low-signal openers exchanged between our OWN pool accounts. */
const MUTUAL_LINES = [
  'привет, как дела?',
  'здарова!',
  'ты тут?',
  'как оно?',
  'хэй) что нового',
  'доброго дня',
  'привет, давно не виделись',
]

/**
 * Outreach warm-up runner (anti-ban core).
 *
 * Bought Telegram accounts are burned the moment they message strangers from a
 * cold, empty profile. This runner ramps every pool account through a
 * day-based schedule before it is ever allowed to touch a real lead:
 *
 *   day 0      cold  → warming : profile is filled in (handled at connect time)
 *   days 1–3   warming        : passive presence only (read, come/go online)
 *   days 4–7   warming        : light mutual activity inside the pool
 *   day >= N   warming → ready : graduate once aged enough AND spam-clean
 *
 * Only `ready` + `clean` accounts are handed to the send pipeline (see the
 * manager send action's eligibility gate). The runner itself performs ONLY safe
 * imitation through the registry `warm` adapter (presence toggling + light
 * dialog reads) — it never sends messages to strangers. The heavy lifting is
 * the DB day-ramp: advancing `warmup_day`/`warmup_stage` on a human-like
 * schedule so accounts mature at a natural pace instead of all at once.
 *
 * Everything here is best-effort and swallows errors: a warm-up failure must
 * never crash the worker or block the send pipeline.
 */

interface WarmupConfig {
  /** Days of ramp before an account may graduate to `ready`. */
  graduationDay: number
  /** Max accounts to advance per tick (keeps DB churn small). */
  batchSize: number
  /** Active-hours window in MSK; outside it the runner idles (human sleep). */
  activeHourStart: number
  activeHourEnd: number
}

const DEFAULTS: WarmupConfig = {
  graduationDay: 8,
  batchSize: 10,
  activeHourStart: 9,
  activeHourEnd: 23,
}

async function loadConfig(): Promise<WarmupConfig> {
  const raw = await getOutreachSetting<Partial<WarmupConfig>>('outreach.warmup')
  return { ...DEFAULTS, ...(raw ?? {}) }
}

/** Current hour in Moscow time (the whole product runs on MSK windows). */
function mskHour(): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Moscow',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(new Date())
  const h = parts.find((p) => p.type === 'hour')?.value ?? '0'
  return Number(h) % 24
}

/** Whole days elapsed since the account started warming (min 0). */
function daysSinceStart(row: OutreachAccountRow): number {
  if (!row.warmup_started_at) return 0
  const started = new Date(row.warmup_started_at).getTime()
  if (Number.isNaN(started)) return 0
  return Math.max(0, Math.floor((Date.now() - started) / 86_400_000))
}

function stageForDay(day: number, graduationDay: number): string {
  if (day >= graduationDay) return 'ready'
  return 'warming'
}

let sweepInFlight = false

/**
 * One warm-up pass. `warm` is the registry presence adapter (same one the
 * session warm-up sweep uses); a missing/offline session is a safe no-op.
 * The runner decides WHO advances and WHEN, and performs a gentle presence
 * tick on each advanced account.
 */
export async function runOutreachWarmupTick(
  warm: (
    channelId: string,
    opts: { online: boolean; readDialogs: boolean },
  ) => Promise<void>,
): Promise<void> {
  if (sweepInFlight) return
  sweepInFlight = true
  try {
    const cfg = await loadConfig()

    // Respect human active hours — an account that acts at 4am is a red flag.
    const hour = mskHour()
    const awake =
      cfg.activeHourStart <= cfg.activeHourEnd
        ? hour >= cfg.activeHourStart && hour < cfg.activeHourEnd
        : hour >= cfg.activeHourStart || hour < cfg.activeHourEnd
    if (!awake) return

    const candidates = await claimWarmupCandidates(cfg.batchSize)
    for (const row of candidates) {
      try {
        const day = daysSinceStart(row)
        const stage = stageForDay(day, cfg.graduationDay)

        // Graduation additionally requires a clean spam status — a limited or
        // blocked account never becomes `ready` no matter how long it aged.
        const canGraduate = stage === 'ready' && row.spamblock_status === 'clean'
        const nextStage = canGraduate ? 'ready' : 'warming'

        if (day !== row.warmup_day || nextStage !== row.warmup_stage) {
          await bumpWarmupDay(row.id, day, nextStage)
        }

        // Safe imitation on the live session (best-effort): come/go online and
        // occasionally read a dialog page. Never sends anything.
        if (row.channel_id) {
          await warm(row.channel_id, {
            online: Math.random() < 0.5,
            readDialogs: Math.random() < 0.25,
          }).catch(() => {})
        }
        await markAccountAction(row.id)
      } catch (err) {
        logger.warn(
          { accountId: row.id, err },
          'outreach warmup tick failed for account (non-fatal)',
        )
      }
    }
  } catch (err) {
    logger.error({ err }, 'outreach warmup sweep failed')
  } finally {
    sweepInFlight = false
  }
}

let mutualInFlight = false

/**
 * Mutual warming (item 4): our own pool accounts exchange a short casual line
 * so each profile shows organic outgoing/incoming traffic BEFORE it ever
 * messages a real lead. This is far safer than sending to strangers — every
 * peer is an account we own, so there is no report/spam risk, yet Telegram sees
 * genuine two-way dialog activity.
 *
 * Conservative by design: runs only inside active hours, one pairing per tick,
 * with a low probability so the pool doesn't light up in a burst. Best-effort;
 * a FLOOD_WAIT or offline session is swallowed.
 */
export async function runOutreachMutualWarmTick(
  getSession: (channelId: string) => WarmSendSession | undefined,
): Promise<void> {
  if (mutualInFlight) return
  mutualInFlight = true
  try {
    const cfg = await loadConfig()
    const hour = mskHour()
    const awake =
      cfg.activeHourStart <= cfg.activeHourEnd
        ? hour >= cfg.activeHourStart && hour < cfg.activeHourEnd
        : hour >= cfg.activeHourStart || hour < cfg.activeHourEnd
    if (!awake) return

    // Only occasionally — keeps the pool's activity sparse and human-like.
    if (Math.random() > 0.5) return

    const peers = await listWarmPeers(8)
    if (peers.length < 2) return // need at least a sender and a recipient

    // Pick a random sender that has a live session and a distinct recipient.
    const shuffled = peers.slice().sort(() => Math.random() - 0.5)
    for (const sender of shuffled) {
      const session = getSession(sender.channel_id)
      if (!session) continue
      const recipient = shuffled.find(
        (p) => p.id !== sender.id && p.username,
      )
      if (!recipient?.username) continue

      const line = MUTUAL_LINES[Math.floor(Math.random() * MUTUAL_LINES.length)]
      try {
        await session.personalStartDialog(`@${recipient.username}`, line)
        await markAccountAction(sender.id)
        logger.info(
          { from: sender.id, to: recipient.id },
          'outreach mutual warm exchange',
        )
      } catch (err) {
        logger.warn({ from: sender.id, err }, 'mutual warm send failed (non-fatal)')
      }
      break // one pairing per tick
    }
  } catch (err) {
    logger.error({ err }, 'outreach mutual warm sweep failed')
  } finally {
    mutualInFlight = false
  }
}
