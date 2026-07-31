import type { SimOutcome, SimSettings, SimThreadRow, SimTone } from './types'
import {
  chance,
  humanizeBubbles,
  makePersona,
  randInt,
  reactionMessage,
  splitIntoMessages,
} from './content'
import { type Behavior, generateReply } from './generate'
import { ensureLock, releaseLock } from './lock'
import {
  bumpNudgeBackoff,
  bumpRepliesTotal,
  bumpSpawnedTotal,
  claimDueThreads,
  claimSpawnSlot,
  countActiveThreads,
  createSimConversation,
  expireStaleThreads,
  findConversationsAwaitingManager,
  findThreadsAwaitingReaction,
  getConversationRouting,
  getSettings,
  getTranscript,
  insertInboundMessage,
  listUsableChannels,
  scheduleReaction,
  stopCampaign,
  updateThread,
  type SimChannel,
} from './store'
import { pick } from './content'
import { computeMood, type MoodResult } from './mood'
import { logAi } from '@/lib/data/ai-log'
import { runLivechatAutopilot } from '@/lib/autopilot/runtime'

import type { ChannelType } from '@/lib/types'

/**
 * The simulator engine.
 *
 * A single interval "tick" (default every ~5s) drives everything:
 *   1. maybe spawn a new thread (rate-limited via an atomic DB spawn slot)
 *   2. schedule reactions to any manager replies we haven't answered yet
 *   3. process any threads whose scheduled action time has arrived
 *
 * All timing is persisted in the DB (next_run_at / next_spawn_at), so the loop
 * is stateless and survives restarts — on boot it simply resumes from whatever
 * is due.
 *
 * Single-instance: work only happens in the process that holds a PostgreSQL
 * advisory lock (see ./lock). On a single-process VPS that's always this one;
 * in a cluster, standby processes idle and take over if the owner dies. The
 * DB-level atomic claims make any brief overlap harmless anyway.
 */

const TICK_MS = 5_000

/**
 * How long AFTER THE MANAGER SPOKE a thread may sit before we treat the client
 * as having ghosted and close it as `done`. This applies ONLY when the client
 * went silent on a manager reply — dialogues still waiting on the manager are
 * kept alive (the backlog sweep keeps trying to get them answered) so the sim
 * never abandons the pile of dialogues it created. See expireStaleThreads.
 */
const CLIENT_GHOST_MINUTES = 180

/**
 * De-duplicated skip notices for the "Логи" tab. The tick runs every ~5s, so a
 * standing condition (e.g. "no usable channels") would otherwise flood the log.
 * We only emit a note when the reason CHANGES, and reset it whenever real work
 * happens, so the operator sees a single clear line per condition.
 */
let lastSimNote = ''
function noteSim(
  reason: string,
  level: 'info' | 'warn',
  message: string,
): void {
  if (lastSimNote === reason) return
  lastSimNote = reason
  void logAi({ level, source: 'sim', event: `skip.${reason}`, message })
}

interface EngineHandle {
  timer: ReturnType<typeof setInterval> | null
  running: boolean
  ticking: boolean
}

const g = globalThis as unknown as { __clientSimEngine?: EngineHandle }

function handle(): EngineHandle {
  if (!g.__clientSimEngine) {
    g.__clientSimEngine = { timer: null, running: false, ticking: false }
  }
  return g.__clientSimEngine
}

/**
 * Hard kill-switch, independent of the DB `enabled` flag. Set
 * `CLIENT_SIM_DISABLED=1` (or true/yes) in the environment to guarantee the
 * simulator can NEVER spawn or drive dialogues on this host — the engine
 * refuses to start, any running loop stops itself on the next tick, and boot
 * resume is skipped. This is the definitive "off" when you want to be certain
 * the simulator is not touching production, no matter what the stored setting
 * says.
 */
export function simHardDisabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.CLIENT_SIM_DISABLED ?? '')
}

export function engineRunning(): boolean {
  return handle().running
}

/** Start the background loop (idempotent). */
export function startEngine(): void {
  if (simHardDisabled()) {
    console.log('[client-sim] start refused: CLIENT_SIM_DISABLED is set')
    return
  }
  const h = handle()
  if (h.timer) return
  h.running = true
  h.timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  // Kick an immediate tick so enabling feels responsive.
  void tick()
  console.log('[client-sim] engine started')
  lastSimNote = ''
  void logAi({
    level: 'info',
    source: 'sim',
    event: 'engine.started',
    message: 'Симулятор запущен — начинаю создавать диалоги в фоне.',
  })
}

/** Stop the loop. Threads stay in the DB and resume when re-enabled. */
export function stopEngine(): void {
  const h = handle()
  if (h.timer) {
    clearInterval(h.timer)
    h.timer = null
  }
  h.running = false
  // Give up the lock so a standby process (if any) can take over immediately.
  void releaseLock()
  console.log('[client-sim] engine stopped')
  void logAi({
    level: 'info',
    source: 'sim',
    event: 'engine.stopped',
    message: 'Симулятор остановлен.',
  })
}

/* --------------------------------- tick --------------------------------- */

async function tick(): Promise<void> {
  const h = handle()
  if (h.ticking) return // never overlap ticks
  h.ticking = true
  try {
    if (!process.env.DATABASE_URL) return

    // Hard kill-switch wins over everything: stop the loop dead so a lingering
    // interval can never keep spawning after the env flag is set.
    if (simHardDisabled()) {
      noteSim(
        'hard_disabled',
        'warn',
        'Симулятор принудительно отключён переменной CLIENT_SIM_DISABLED — цикл остановлен.',
      )
      stopEngine()
      return
    }

    // Single-instance guard: only the process holding the advisory lock does
    // real work. Standby processes keep ticking and will take over if the
    // owner dies (PostgreSQL frees the lock on session end).
    const owns = await ensureLock()
    if (!owns) return

    const settings = await getSettings()
    if (!settings.enabled) {
      noteSim(
        'disabled',
        'info',
        'Симулятор выключен в настройках — цикл остановлен, новые диалоги не создаются.',
      )
      // Stop the interval entirely rather than just skipping: "off" should mean
      // the loop is truly halted. Re-enabling via the panel calls startEngine()
      // again, and a restart resumes only if the stored flag is still enabled.
      stopEngine()
      return
    }

    // NOTE: the simulator is fully INDEPENDENT of the AI-manager master switch
    // (the two toggles never interact). The simulator keeps spawning and driving
    // its own client-side turns regardless of whether the AI manager is on. When
    // the AI manager is OFF, `triggerManagerReply` simply no-ops, so sim dialogs
    // sit unanswered until the operator turns the manager on — that is an accepted
    // operator responsibility, not a reason to pause the simulator. The old
    // "deadlock guard" that paused everything here has been removed; the backlog
    // sweep's per-conversation exponential backoff (`bumpNudgeBackoff`) already
    // prevents the runaway nudge loop that guard was working around.

    // Retire only dialogues the CLIENT abandoned (manager replied, client went
    // silent ≥ CLIENT_GHOST_MINUTES) plus an absolute 48h backstop. Dialogues
    // still waiting on the manager are deliberately NOT reaped here — the
    // backlog sweep keeps trying to get them answered so the sim continues the
    // pile it created instead of killing it.
    const reaped = await expireStaleThreads(CLIENT_GHOST_MINUTES)
    if (reaped > 0) {
      lastSimNote = ''
      void logAi({
        level: 'info',
        source: 'sim',
        event: 'reaped',
        message: `Закрыто ${reaped} диалогов, где клиент перестал отвечать (≥ ${CLIENT_GHOST_MINUTES} мин после ответа менеджера) — освободил место для новых.`,
      })
    }

    // Nudge the AI manager on any dialogue that's stuck waiting for a reply
    // (last message is the client's). Covers old conversations created before
    // the auto-trigger existed, or ones where the manager call failed earlier.
    await sweepBacklog()

    // Spawn cadence/timing is derived from "dialogues per day" — UNLESS a
    // campaign is active, in which case spawns are paced to hit the campaign's
    // target within its window. The number of simultaneously-live dialogues is
    // an INDEPENDENT operator knob (maxConcurrent, up to ~100+).
    await maybeSpawn(settings)
    await scheduleManagerReactions()
    await processDueThreads()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log('[client-sim] tick error:', msg)
    void logAi({
      level: 'error',
      source: 'sim',
      event: 'tick.error',
      message: `Ошибка цикла симулятора: ${msg}`,
    })
  } finally {
    h.ticking = false
  }
}

/* -------------------------------- spawning ------------------------------ */

async function maybeSpawn(settings: SimSettings): Promise<void> {
  const channelIds = settings.channelIds
  const maxConcurrent = settings.maxConcurrent

  // Average seconds between new dialogues. Two regimes:
  //  • CAMPAIGN active: pace the REMAINING dialogues across the REMAINING window
  //    so we open `campaignTarget` new dialogues by `campaignEndsAt`, then stop.
  //  • otherwise: steady "dialogues per day" cadence.
  let avgGapSec: number
  if (settings.campaignActive) {
    const done = Math.max(0, settings.spawnedTotal - settings.campaignBaseline)
    const remaining = settings.campaignTarget - done
    const endsAt = settings.campaignEndsAt
      ? new Date(settings.campaignEndsAt).getTime()
      : 0
    const windowLeftSec = Math.max(0, Math.round((endsAt - Date.now()) / 1000))

    // Campaign finished — target met or window elapsed. Stop it and bail; the
    // steady rate resumes only if the operator left dialogsPerDay running.
    if (remaining <= 0 || windowLeftSec <= 0) {
      await stopCampaign(true)
      noteSim(
        'campaign_done',
        'info',
        remaining <= 0
          ? `Кампания завершена: создано ${done}/${settings.campaignTarget} диалогов.`
          : `Кампания завершена по времени: создано ${done}/${settings.campaignTarget} диалогов за отведённый срок.`,
      )
      return
    }
    // Spread the remaining spawns evenly across the remaining window.
    avgGapSec = Math.max(15, Math.round(windowLeftSec / remaining))
  } else {
    // "0 dialogues per day" is an explicit operator choice: keep the simulator
    // RUNNING (existing dialogues still get replies via processDueThreads), but
    // never open new ones. Previously Math.max(1, …) floored this to 1/day, so
    // the simulator kept spawning even at 0 — that was the reported bug.
    const perDay = Math.floor(settings.dialogsPerDay) || 0
    if (perDay <= 0) {
      noteSim(
        'spawn_paused',
        'info',
        'Создание новых диалогов приостановлено (0 диалогов/сутки). Существующие диалоги продолжают жить — отвечаю в них как обычно.',
      )
      return
    }
    avgGapSec = Math.max(20, Math.round(86_400 / perDay))
  }

  // INDEPENDENT concurrency cap: how many dialogues may be live at once,
  // decoupled from throughput. "Live" = every non-done thread, INCLUDING the
  // ones currently asleep / said-later / vanished — they still occupy a slot
  // (that's the point: a big simultaneous crowd where many are dormant, not all
  // typing at once). Defaults to 100.
  const maxThreads = Math.max(1, Math.min(1_000, Math.round(maxConcurrent) || 100))
  const active = await countActiveThreads()
  if (active >= maxThreads) {
    noteSim(
      'at_capacity',
      'info',
      `Достигнут потолок одновременных диалогов (${active}/${maxThreads}) — новые не создаю, пока часть не завершится. Часть из них сейчас «спит»/молчит — это нормально.`,
    )
    return
  }

  // Human traffic isn't metronomic. Base jitter spreads each gap across
  // 0.45×–1.8× the average so arrivals gap unpredictably instead of ticking
  // like a clock — applied in BOTH regimes so even a campaign looks organic.
  let nextDelay = Math.round(avgGapSec * (0.45 + Math.random() * 1.35))
  // The heavy multipliers — long quiet stretches, night slowdown — are only for
  // the STEADY regime. A campaign has an explicit deadline, so stretching gaps
  // could miss the target; we keep only the light jitter above for it.
  if (!settings.campaignActive) {
    if (chance(0.15)) nextDelay = Math.round(nextDelay * randInt(2, 4))
    else if (chance(0.06)) nextDelay = Math.max(15, Math.round(nextDelay * 0.25))
    // People show up less at night: stretch gaps during 23:00–08:00 local time.
    const hour = new Date().getHours()
    if (hour >= 23 || hour < 8) nextDelay = Math.round(nextDelay * (1.5 + Math.random() * 2))
  }

  // Bail out BEFORE claiming a spawn slot if there's nowhere to spawn — a
  // claimed slot both reschedules next_spawn_at and (previously) bumped the
  // spawned_total counter, so consuming it with no usable channel wasted a
  // window and inflated the stat.
  const channels = await listUsableChannels(channelIds)
  if (channels.length === 0) {
    noteSim(
      'no_channels',
      'warn',
      'Нет подходящих каналов для симуляции — выберите каналы в настройках симулятора, иначе новые диалоги не создаются.',
    )
    return
  }

  // Atomically claim the spawn slot; only the winner proceeds.
  const won = await claimSpawnSlot(nextDelay)
  if (!won) return

  const channel: SimChannel = pick(channels)
  // "Polygamous" population: every persona rolls its OWN tone and aggression so
  // the swarm spans polite→toxic instead of sounding like one configured voice.
  const persona = makePersona(
    channel.type as ChannelType,
    rollAggression(),
    rollTone(),
  )

  const body = await generateReply({
    persona,
    history: [],
    behavior: 'open',
  })
  // No template fallback: if the AI couldn't write the opening line, DON'T
  // create a half-baked conversation. Skip this spawn and try again next tick.
  if (!body) {
    noteSim(
      'ai_unavailable',
      'warn',
      'ИИ недоступен — новый диалог не создан (без шаблонов). Проверьте AI_GATEWAY_API_KEY и баланс AI Gateway.',
    )
    return
  }
  // A real person often opens with a couple of short messages rather than one
  // line. Seed the conversation with the FIRST bubble, then post the rest with
  // typing gaps; the manager is triggered once, after the whole opening lands.
  const bubbles = splitIntoMessages(body, persona.style)
  const firstBubble = bubbles[0] ?? body
  const conversationId = await createSimConversation(channel, persona, firstBubble)
  // Count the spawn only once the conversation actually exists, so the stat
  // reflects real spawns rather than claimed-but-failed attempts.
  await bumpSpawnedTotal()
  await updateThread(conversationId, {
    state: 'chatting',
    turns: 1,
    nextRunAt: null, // now waiting on the manager
  })
  console.log(
    `[client-sim] spawned ${persona.channelType} thread (${persona.name}) on channel ${channel.id}`,
  )
  // Real work happened — allow skip notices to fire again next time a standing
  // condition appears.
  lastSimNote = ''
  void logAi({
    level: 'info',
    source: 'sim',
    event: 'spawned',
    message: `Создан новый диалог: «${persona.name}» (${persona.channelType}) написал: "${body.slice(0, 160)}"`,
    channelType: persona.channelType,
  })
  // Post any remaining opening bubbles with typing gaps, then let the AI manager
  // answer the full opening like any real inbound (triggered inside, once).
  void deliverFollowupBubbles(conversationId, persona.name, bubbles.slice(1), body)
}

/* --------------------- reacting to manager replies ---------------------- */

/**
 * For every thread where the manager has posted a reply we haven't reacted to,
 * schedule a human-like delayed reaction. We DON'T reply instantly — we set
 * next_run_at a few seconds/minutes out so it reads as a real person typing
 * back later.
 */
async function scheduleManagerReactions(): Promise<void> {
  // Autonomous reply pacing: a person typically answers within ~20s–4min, but
  // sometimes near-instantly and sometimes not for a long while. These bounds
  // are fixed (not operator-tunable) so behaviour always reads as human.
  const replyMinSec = 20
  const replyMaxSec = 240
  const pending = await findThreadsAwaitingReaction(40)
  for (const p of pending) {
    let delay: number
    // Sometimes a real person just... doesn't answer for a long while.
    if (chance(0.12)) {
      delay = randInt(replyMaxSec * 3, replyMaxSec * 8)
    } else if (chance(0.08)) {
      // "Glanced at the phone" — a rare near-instant reply.
      delay = randInt(3, 12)
    } else {
      delay = randInt(replyMinSec, replyMaxSec)
    }
    // People are slower at night: stretch delays during 23:00–08:00 (server
    // local time) so the daily rhythm isn't perfectly flat around the clock.
    const hour = new Date().getHours()
    if (hour >= 23 || hour < 8) {
      delay = Math.round(delay * (2 + Math.random() * 4))
    }
    await scheduleReaction(p.thread.conversationId, p.managerMessageId, delay)
  }
}

/* ---------------------- processing scheduled turns ---------------------- */

async function processDueThreads(): Promise<void> {
  const due = await claimDueThreads(20)
  for (const thread of due) {
    try {
      await runThreadTurn(thread)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.log('[client-sim] thread turn error:', msg)
      void logAi({
        level: 'error',
        source: 'sim',
        event: 'turn.error',
        message: `Ошибка при ответе клиента-симуляции: ${msg}`,
      })
    }
  }
}

/**
 * Hand a freshly-posted simulated client message to the AI MANAGER so it
 * answers it just like a real inbound. We deliberately call the SAME public
 * entry point a real channel webhook uses (`runLivechatAutopilot`) rather than
 * touching the manager's brain directly — the simulator and the AI manager stay
 * completely separate systems; the simulator only "knocks on the front door".
 *
 * Fire-and-forget: the manager replies on its own schedule and the reply lands
 * as a normal outbound message, which the simulator's next tick picks up to
 * continue the dialogue. Fully self-guarded so it can never break a tick.
 */
async function triggerManagerReply(
  conversationId: string,
  text: string,
): Promise<void> {
  try {
    const routing = await getConversationRouting(conversationId)
    if (!routing) return
    await runLivechatAutopilot({
      managerId: routing.managerId,
      channelId: routing.channelId,
      conversationId,
      text,
    })
  } catch (err) {
    void logAi({
      level: 'error',
      source: 'sim',
      event: 'manager_trigger.error',
      message: `Не удалось передать сообщение ИИ-менеджеру: ${
        err instanceof Error ? err.message : String(err)
      }`,
      conversationId,
    })
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Human "typing" gap between consecutive bubbles of the SAME message. Short
// enough to read as one flurry, long enough to look hand-typed.
const CHUNK_GAP_MIN_SEC = 2
const CHUNK_GAP_MAX_SEC = 9

/**
 * Deliver the follow-up bubbles of a client message (everything after the first,
 * which the caller already posted) with human-like typing gaps, then hand the
 * FULL message to the AI manager exactly once.
 *
 * Fire-and-forget: the engine is a long-lived leader process (setInterval +
 * advisory lock), so these short timers safely outlive the tick that started
 * them. The manager is triggered only AFTER the last bubble lands, so it always
 * answers the complete thought rather than each fragment — and the backlog
 * sweep's 90s stale guard means nothing else can nudge the manager mid-flurry.
 * If the process dies mid-delivery, the same backlog sweep later picks the
 * dialogue up (last message is inbound) and nudges the manager, so no message
 * is ever permanently orphaned.
 */
async function deliverFollowupBubbles(
  conversationId: string,
  authorName: string,
  tail: string[],
  fullBody: string,
): Promise<void> {
  try {
    for (const bubble of tail) {
      await sleep(randInt(CHUNK_GAP_MIN_SEC, CHUNK_GAP_MAX_SEC) * 1000)
      await insertInboundMessage(conversationId, authorName, bubble)
    }
  } catch (err) {
    console.log(
      '[client-sim] follow-up bubble delivery failed:',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    // Always hand the finished message to the manager, even if a tail bubble
    // failed — silence would otherwise strand the dialogue.
    void triggerManagerReply(conversationId, fullBody)
  }
}

// How many stuck dialogues to re-nudge per tick. Bounded so a large backlog
// drains gradually instead of hammering the gateway all at once, but high
// enough that a pile of 100+ sim-created dialogues actually gets worked through
// (the whole point: the sim must continue the dialogues it created, not just
// the newest couple).
const BACKLOG_BATCH = 12

/**
 * Re-trigger the AI manager on dialogues whose last message is the client's and
 * that have been sitting unanswered. This is what unblocks the "old hanging
 * dialogues": each tick we grab a small batch and knock on the manager's door
 * again. The manager's own single-flight + AI-led guards make repeat nudges
 * safe (a duplicate never produces a double reply).
 */
async function sweepBacklog(): Promise<void> {
  const stuck = await findConversationsAwaitingManager(BACKLOG_BATCH)
  if (stuck.length === 0) return
  void logAi({
    level: 'info',
    source: 'sim',
    event: 'backlog.nudge',
    message: `Догоняю ${stuck.length} «зависших» диалогов — прошу ИИ-менеджера ответить.`,
  })
  for (const c of stuck) {
    await triggerManagerReply(c.conversationId, c.lastClientBody)
    // Exponential per-conversation backoff (90s → 3m → 9m … capped ~2h) so a
    // manager that never answers this particular dialogue isn't poked every
    // tick forever. A real manager reply resets the backoff (scheduleReaction).
    await bumpNudgeBackoff(c.conversationId)
  }
}

/**
 * Decide how the persona behaves this turn based on mood + aggression + a die
 * roll, generate the line, post it, and advance the state machine. This is
 * where the "always react differently" behaviour lives: intent is re-rolled
 * every single turn, weighted by the persona's temperament.
 */
async function runThreadTurn(thread: SimThreadRow): Promise<void> {
  const { persona, conversationId } = thread

  // Race guard: if an operator stepped into this dialogue (paused it) between
  // the scheduler claiming it and now, back off immediately so we never post a
  // simulated line into a dialogue the human has taken over.
  if (thread.paused) return

  // A thread that was parked (said "later", was asleep, or had vanished) and is
  // now due again = the client is coming BACK to the conversation.
  const wasDormant =
    thread.state === 'later' ||
    thread.state === 'sleeping' ||
    thread.state === 'vanished'

  // Daily rhythm: if they're due to act but it's the middle of the night (or a
  // lazy weekend), most of the time they just sleep and pick it up later rather
  // than texting at 3am. Comebacks are already scheduled for daytime, so this
  // mainly parks night-time nudges/reactions.
  if (!wasDormant && (await maybeSleepThroughOffHours(thread))) return

  const transcript = await getTranscript(conversationId)
  const history = transcript.map((l) => ({
    role: (l.direction === 'out' ? 'manager' : 'client') as 'manager' | 'client',
    body: l.body,
  }))

  // Recompute the persona's live mood from the whole conversation — this is
  // what makes the emotional arc react to how the manager behaves.
  const mood = computeMood(persona, history, thread.turns)

  // Whether the manager ever replied determines nudge vs reaction.
  const managerSpoke = transcript.some((l) => l.direction === 'out')
  const rolled = managerSpoke
    ? rollBehavior(persona.temper, persona.style.profanity, thread.turns, mood)
    : 'nudge'

  // Sticker/emoji reaction: mid-conversation, a real person sometimes just taps
  // a 👍/😂/«))» at the manager's message instead of typing a reply. Only when
  // the manager just spoke, a few turns in, and not while sulking/angry. This
  // still counts as engagement, so we post it and keep waiting on the manager.
  if (
    managerSpoke &&
    thread.turns >= 1 &&
    rolled !== 'angry' &&
    (persona.style.emojiRate ?? 0) > 0.1 &&
    chance(0.12)
  ) {
    await insertInboundMessage(conversationId, persona.name, reactionMessage())
    await bumpRepliesTotal()
    await updateThread(conversationId, {
      state: 'chatting',
      turns: thread.turns + 1,
      nextRunAt: null,
    })
    void triggerManagerReply(conversationId, '(реакция)')
    return
  }

  // Decide what shape this turn takes: a normal reply, a quick "busy, later",
  // a short sulk, a long vanish, or an outright ending (with a reason).
  const plan = rollTurnPlan(rolled, thread.turns, wasDormant)

  // --- Silent transitions (no message posted) --------------------------------
  if (plan.kind === 'ignore') {
    // Brief sulk — resurface within minutes.
    await updateThread(conversationId, {
      state: 'ignoring',
      nextRunAt: isoIn(randInt(180, 1200)),
    })
    return
  }
  if (plan.kind === 'vanish') {
    // Drop off for a day+ then (usually) come back — a scheduled comeback.
    await updateThread(conversationId, {
      state: 'vanished',
      nextRunAt: isoIn(randInt(20 * 3600, 72 * 3600)),
    })
    void logAi({
      level: 'info',
      source: 'sim',
      event: 'vanished',
      message: `«${persona.name}» пропал — вернётся через день-другой.`,
      conversationId,
      channelType: persona.channelType,
    })
    return
  }

  // --- Turns that DO post a message ------------------------------------------
  // Pick the register the line should convey.
  let behavior: Behavior = rolled
  if (plan.kind === 'later') behavior = 'later'
  else if (plan.kind === 'end' && (plan.outcome === 'left' || plan.outcome === 'competitor'))
    behavior = 'leaving'
  else if (wasDormant) behavior = 'comeback'

  const body = await generateReply({
    persona,
    history,
    behavior,
    moodHint: managerSpoke ? mood.hint : undefined,
  })
  // No template fallback: if the AI couldn't write this turn, post NOTHING and
  // keep the thread alive to retry shortly. Silence beats robotic filler.
  if (!body) {
    void logAi({
      level: 'warn',
      source: 'sim',
      event: 'turn.ai_unavailable',
      message:
        'ИИ не сформировал реплику клиента — пропускаю ход (без шаблонов), повтор позже.',
      conversationId,
      channelType: persona.channelType,
    })
    await updateThread(conversationId, { nextRunAt: isoIn(randInt(45, 180)) })
    return
  }

  if (wasDormant) {
    void logAi({
      level: 'info',
      source: 'sim',
      event: 'comeback',
      message: `«${persona.name}» вернулся в диалог после паузы.`,
      conversationId,
      channelType: persona.channelType,
    })
  }

  // Split into chat bubbles, then weave in believable human glitches (typo +
  // «*правка», autocorrect blunder, accidental early send, double-tap dupes).
  // Post the first bubble now, advance the state machine, then deliver the rest
  // with typing gaps and trigger the manager once at the end.
  const bubbles = humanizeBubbles(splitIntoMessages(body, persona.style), persona.style)
  await insertInboundMessage(conversationId, persona.name, bubbles[0] ?? body)
  await bumpRepliesTotal()

  if (plan.kind === 'later') {
    // Said "busy, later" — go dormant for a few hours, then a comeback fires.
    await updateThread(conversationId, {
      state: 'later',
      turns: thread.turns + 1,
      nextRunAt: isoIn(randInt(3 * 3600, 10 * 3600)),
    })
    void logAi({
      level: 'info',
      source: 'sim',
      event: 'later',
      message: `«${persona.name}» занят — обещал ответить позже.`,
      conversationId,
      channelType: persona.channelType,
    })
  } else if (plan.kind === 'end') {
    await updateThread(conversationId, {
      state: 'done',
      turns: thread.turns + 1,
      nextRunAt: null,
      outcome: plan.outcome,
    })
    void logAi({
      level: 'info',
      source: 'sim',
      event: `done.${plan.outcome}`,
      message: `«${persona.name}»: ${OUTCOME_LABEL[plan.outcome]}.`,
      conversationId,
      channelType: persona.channelType,
    })
  } else {
    // Normal reply: wait on the manager again, unless we're poking an absent
    // manager (nudge) — then schedule another poke later.
    await updateThread(conversationId, {
      state: 'chatting',
      turns: thread.turns + 1,
      nextRunAt: rolled === 'nudge' ? isoIn(randInt(120, 600)) : null,
    })
  }

  // Follow-up bubbles + the (single) manager trigger, on a human typing cadence.
  void deliverFollowupBubbles(conversationId, persona.name, bubbles.slice(1), body)
}

/** Human-readable reasons for the "Логи" tab / dashboard. */
const OUTCOME_LABEL: Record<SimOutcome, string> = {
  ended: 'разговор естественно завершился',
  left: 'переписался и потерял интерес, ушёл',
  competitor: 'сказал что уже нашёл другой вариант',
  ghosted: 'просто пропал и не вернулся',
  angry: 'вспылил и закрыл разговор',
}

/* ------------------------------- rolls ---------------------------------- */

/**
 * Weighted behaviour selection. Angrier tempers + higher profanity skew toward
 * anger/dismissal; "туповатый" skews confused; everyone can be curious.
 */
export function rollBehavior(
  temper: string,
  profanity: number,
  turns: number,
  mood?: MoodResult,
): Behavior {
  const weights: Record<Behavior, number> = {
    open: 0,
    curious: 4,
    angry: 2 + profanity * 6,
    dismissive: 2,
    confused: 2,
    nudge: 0,
    // Engine-driven behaviours (chosen by the turn planner / lifecycle), never
    // picked by this weighted roll — kept at 0 to satisfy the exhaustive record.
    later: 0,
    comeback: 0,
    leaving: 0,
  }

  // Temperament nudges.
  if (/наглый|дерзкий|борзый|вспыльчивый|нервный/.test(temper)) weights.angry += 4
  if (/подозрительн|осторожн/.test(temper)) weights.dismissive += 3
  if (/тупова|простоват/.test(temper)) weights.confused += 4
  if (/жадн|делов/.test(temper)) weights.curious += 4
  if (/спокойн|дружелюб|уставш/.test(temper)) weights.curious += 2

  // Later in a conversation, offended reactions become more likely (the shady
  // offer has landed by now).
  if (turns >= 3) weights.angry += 3
  if (turns >= 5) weights.dismissive += 3

  // Live mood dominates once it builds up: a frustrated/suspicious persona
  // leans angry, a disengaged one leans dismissive, an interested one curious.
  if (mood) {
    weights.angry += mood.angerBoost
    weights.dismissive += mood.dismissBoost
    if (mood.interest >= 0.6 && mood.frustration < 0.4) weights.curious += 3
  }

  return weightedPick(weights)
}

/**
 * What shape a turn takes:
 *   reply  — post a normal message and keep chatting
 *   later  — post a quick "busy, later" and go dormant for hours
 *   ignore — brief sulk, resurface in minutes (no message)
 *   vanish — drop off for a day+ then come back (no message)
 *   end    — finish the dialogue, with a reason (outcome)
 */
type TurnPlan =
  | { kind: 'reply' }
  | { kind: 'later' }
  | { kind: 'ignore' }
  | { kind: 'vanish' }
  | { kind: 'end'; outcome: SimOutcome }

/**
 * Decide this turn's shape from behaviour + length + whether the client is just
 * coming back. Tuned so most turns are replies, endings carry a human reason,
 * and disappearances split between short sulks, "later", and long vanishes.
 */
function rollTurnPlan(
  behavior: Behavior,
  turns: number,
  wasDormant: boolean,
): TurnPlan {
  // A returning client is here to talk — don't immediately bail on them.
  if (wasDormant) {
    if (chance(0.12)) return { kind: 'end', outcome: pickWalkAway() }
    return { kind: 'reply' }
  }

  // Early on, almost always keep talking (tiny chance of a brief sulk).
  if (turns < 2) return chance(0.05) ? { kind: 'ignore' } : { kind: 'reply' }

  // "Занят, отвечу позже" — a small, ever-present chance mid-conversation.
  if (chance(0.06)) return { kind: 'later' }

  if (behavior === 'angry') {
    // Blow-ups sometimes end the chat outright.
    if (chance(0.35)) return { kind: 'end', outcome: 'angry' }
  }
  if (behavior === 'dismissive') {
    if (chance(0.3)) return { kind: 'end', outcome: pickWalkAway() }
    if (chance(0.2)) return { kind: 'vanish' }
  }

  // Natural attrition as threads get long.
  if (turns >= 6 && chance(0.25)) {
    return chance(0.5)
      ? { kind: 'end', outcome: pickWalkAway() }
      : { kind: 'vanish' }
  }
  if (turns >= 10 && chance(0.5)) return { kind: 'end', outcome: pickWalkAway() }

  // Occasional silent disappearance mid-chat: short sulk vs long vanish.
  if (chance(0.08)) return chance(0.6) ? { kind: 'ignore' } : { kind: 'vanish' }

  return { kind: 'reply' }
}

/** Pick a "walked away" reason: lost interest vs found a competitor. */
function pickWalkAway(): SimOutcome {
  return chance(0.4) ? 'competitor' : 'left'
}

/**
 * Roll a per-persona writing register. Weighted toward neutral/rough (that's
 * how most people actually message cold job ads) with a healthy spread so the
 * population never sounds uniform. 'mixed' lets a persona drift within a chat.
 */
function rollTone(): SimTone {
  return weightedPick<SimTone>({
    polite: 2,
    neutral: 4,
    rough: 3,
    mixed: 2,
  })
}

/**
 * Roll a per-persona aggression level (0..100). Bell-ish spread via averaging
 * two rolls so extremes are rarer than the messy middle.
 */
function rollAggression(): number {
  const a = randInt(0, 100)
  const b = randInt(0, 100)
  return Math.round((a + b) / 2)
}

function weightedPick<K extends string>(weights: Record<K, number>): K {
  const entries = Object.entries(weights) as [K, number][]
  const total = entries.reduce((s, [, w]) => s + Math.max(0, w), 0)
  if (total <= 0) return entries[0][0]
  let r = Math.random() * total
  for (const [k, w] of entries) {
    r -= Math.max(0, w)
    if (r <= 0) return k
  }
  return entries[entries.length - 1][0]
}

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString()
}

/* ------------------------- daily-rhythm helpers ------------------------- */

/** Night hours (server local): people mostly don't reply 23:00–08:00. */
function isNight(d = new Date()): boolean {
  const h = d.getHours()
  return h >= 23 || h < 8
}

/** Weekend (server local): traffic is sparser and lazier. */
function isWeekend(d = new Date()): boolean {
  const day = d.getDay()
  return day === 0 || day === 6
}

/**
 * Seconds until "morning" (~08:00 local) with 0–2h jitter so a whole crowd
 * doesn't wake at the same instant. Used to park sleeping threads overnight.
 */
function secondsUntilMorning(): number {
  const now = new Date()
  const wake = new Date(now)
  wake.setHours(8, 0, 0, 0)
  if (now.getHours() >= 8) wake.setDate(wake.getDate() + 1)
  const base = Math.round((wake.getTime() - now.getTime()) / 1000)
  return Math.max(60, base + randInt(0, 2 * 3600))
}

/**
 * If the client is due to act but it's night (or a lazy weekend moment), park
 * the thread as `sleeping`/dormant and reschedule instead of texting at 3am.
 * Returns true if it deferred (caller should stop processing this turn).
 */
async function maybeSleepThroughOffHours(
  thread: SimThreadRow,
): Promise<boolean> {
  const d = new Date()
  if (isNight(d) && chance(0.85)) {
    await updateThread(thread.conversationId, {
      state: 'sleeping',
      nextRunAt: isoIn(secondsUntilMorning()),
    })
    void logAi({
      level: 'info',
      source: 'sim',
      event: 'sleeping',
      message: `«${thread.persona.name}» лёг спать — продолжит утром.`,
      conversationId: thread.conversationId,
      channelType: thread.persona.channelType,
    })
    return true
  }
  if (!isNight(d) && isWeekend(d) && chance(0.3)) {
    await updateThread(thread.conversationId, {
      state: 'sleeping',
      nextRunAt: isoIn(randInt(2 * 3600, 8 * 3600)),
    })
    void logAi({
      level: 'info',
      source: 'sim',
      event: 'sleeping',
      message: `«${thread.persona.name}» отложил на потом — выходной, ответит через несколько часов.`,
      conversationId: thread.conversationId,
      channelType: thread.persona.channelType,
    })
    return true
  }
  return false
}
