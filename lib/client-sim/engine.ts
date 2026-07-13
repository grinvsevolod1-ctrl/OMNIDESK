import type { SimState, SimThreadRow, SimTone } from './types'
import { chance, makePersona, randInt } from './content'
import { type Behavior, generateReply } from './generate'
import { ensureLock, releaseLock } from './lock'
import {
  bumpRepliesTotal,
  bumpSpawnedTotal,
  claimDueThreads,
  claimSpawnSlot,
  countActiveThreads,
  createSimConversation,
  findThreadsAwaitingReaction,
  getSettings,
  getTranscript,
  insertInboundMessage,
  listUsableChannels,
  sampleRealClientLines,
  scheduleReaction,
  updateThread,
  type SimChannel,
} from './store'
import { pick } from './content'
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

export function engineRunning(): boolean {
  return handle().running
}

/** Start the background loop (idempotent). */
export function startEngine(): void {
  const h = handle()
  if (h.timer) return
  h.running = true
  h.timer = setInterval(() => {
    void tick()
  }, TICK_MS)
  // Kick an immediate tick so enabling feels responsive.
  void tick()
  console.log('[client-sim] engine started')
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
}

/* --------------------------------- tick --------------------------------- */

async function tick(): Promise<void> {
  const h = handle()
  if (h.ticking) return // never overlap ticks
  h.ticking = true
  try {
    if (!process.env.DATABASE_URL) return

    // Single-instance guard: only the process holding the advisory lock does
    // real work. Standby processes keep ticking and will take over if the
    // owner dies (PostgreSQL frees the lock on session end).
    const owns = await ensureLock()
    if (!owns) return

    const settings = await getSettings()
    if (!settings.enabled) return

    // Everything is derived autonomously from the single "dialogues per day"
    // knob — concurrency, spawn cadence and reply timing are all computed here
    // so the operator only ever sets throughput.
    await maybeSpawn(settings.channelIds, settings.dialogsPerDay)
    await scheduleManagerReactions()
    await processDueThreads()
  } catch (err) {
    console.log(
      '[v0][client-sim] tick error:',
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    h.ticking = false
  }
}

/* -------------------------------- spawning ------------------------------ */

async function maybeSpawn(
  channelIds: string[],
  dialogsPerDay: number,
): Promise<void> {
  // Average seconds between new dialogues to hit the daily target.
  const perDay = Math.max(1, Math.floor(dialogsPerDay) || 1)
  const avgGapSec = Math.max(20, Math.round(86_400 / perDay))

  // Autonomous concurrency cap: enough headroom for the throughput without
  // letting threads pile up unbounded. Scales with the daily rate.
  const maxThreads = Math.max(5, Math.min(400, Math.round(perDay / 3) + 3))
  const active = await countActiveThreads()
  if (active >= maxThreads) return

  // Human traffic isn't metronomic. Base jitter spreads each gap across
  // 0.45×–1.8× the average; on top of that ~15% of the time we fake a quiet
  // stretch (2–4×) and ~6% a burst (0.25×) so arrivals cluster and gap
  // unpredictably instead of ticking like a clock.
  let nextDelay = Math.round(avgGapSec * (0.45 + Math.random() * 1.35))
  if (chance(0.15)) nextDelay = Math.round(nextDelay * randInt(2, 4))
  else if (chance(0.06)) nextDelay = Math.max(15, Math.round(nextDelay * 0.25))
  // People show up less at night: stretch gaps during 23:00–08:00 local time.
  const hour = new Date().getHours()
  if (hour >= 23 || hour < 8) nextDelay = Math.round(nextDelay * (1.5 + Math.random() * 2))

  // Bail out BEFORE claiming a spawn slot if there's nowhere to spawn — a
  // claimed slot both reschedules next_spawn_at and (previously) bumped the
  // spawned_total counter, so consuming it with no usable channel wasted a
  // window and inflated the stat.
  const channels = await listUsableChannels(channelIds)
  if (channels.length === 0) return

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

  // Learn the channel's real voice, then write the opening line and seed the
  // conversation + first message atomically (no empty-thread flash).
  const referenceLines = await sampleRealClientLines(channel.type as ChannelType)
  const body = await generateReply({
    persona,
    history: [],
    behavior: 'open',
    referenceLines,
  })
  const conversationId = await createSimConversation(channel, persona, body)
  // Count the spawn only once the conversation actually exists, so the stat
  // reflects real spawns rather than claimed-but-failed attempts.
  await bumpSpawnedTotal()
  await updateThread(conversationId, {
    state: 'chatting',
    turns: 1,
    nextRunAt: null, // now waiting on the manager
  })
  console.log(
    `[v0][client-sim] spawned ${persona.channelType} thread (${persona.name}) on channel ${channel.id}`,
  )
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
  const pending = await findThreadsAwaitingReaction(25)
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
  const due = await claimDueThreads(10)
  for (const thread of due) {
    try {
      await runThreadTurn(thread)
    } catch (err) {
      console.log(
        '[v0][client-sim] thread turn error:',
        err instanceof Error ? err.message : String(err),
      )
    }
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

  const transcript = await getTranscript(conversationId)
  const history = transcript.map((l) => ({
    role: (l.direction === 'out' ? 'manager' : 'client') as 'manager' | 'client',
    body: l.body,
  }))

  // Whether the manager ever replied determines nudge vs reaction.
  const managerSpoke = transcript.some((l) => l.direction === 'out')
  const behavior = managerSpoke
    ? rollBehavior(persona.temper, persona.style.profanity, thread.turns)
    : 'nudge'

  // Some turns end the conversation instead of replying.
  const outcome = rollOutcome(behavior, thread.turns)
  if (outcome === 'ghost') {
    // Go silent — mark ignoring, maybe resurface much later, maybe die.
    const resurface = chance(0.4)
    await updateThread(conversationId, {
      state: resurface ? 'ignoring' : 'done',
      nextRunAt: resurface ? isoIn(randInt(180, 1200)) : null,
    })
    return
  }

  const referenceLines = await sampleRealClientLines(persona.channelType)
  const body = await generateReply({ persona, history, behavior, referenceLines })
  await insertInboundMessage(conversationId, persona.name, body)
  await bumpRepliesTotal()

  const nextState: SimState = outcome === 'end' ? 'done' : 'chatting'
  await updateThread(conversationId, {
    state: nextState,
    turns: thread.turns + 1,
    // After replying we wait on the manager again (no self-schedule), unless
    // we're nudging an absent manager — then poke again later.
    nextRunAt:
      nextState === 'done'
        ? null
        : behavior === 'nudge'
          ? isoIn(randInt(120, 600))
          : null,
  })
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
): Behavior {
  const weights: Record<Behavior, number> = {
    open: 0,
    curious: 4,
    angry: 2 + profanity * 6,
    dismissive: 2,
    confused: 2,
    nudge: 0,
  }

  // Temperament nudges.
  if (/наглый|дерзкий|борзый|вспыльчивый|нервный/.test(temper)) weights.angry += 4
  if (/подозрительн|ос��орожн/.test(temper)) weights.dismissive += 3
  if (/тупова|простоват/.test(temper)) weights.confused += 4
  if (/жадн|делов/.test(temper)) weights.curious += 4
  if (/спокойн|дружелюб|уставш/.test(temper)) weights.curious += 2

  // Later in a conversation, offended reactions become more likely (the shady
  // offer has landed by now).
  if (turns >= 3) weights.angry += 3
  if (turns >= 5) weights.dismissive += 3

  return weightedPick(weights)
}

type Outcome = 'reply' | 'end' | 'ghost'

/** Decide whether this turn continues, ends, or ghosts. */
function rollOutcome(behavior: Behavior, turns: number): Outcome {
  // Early on, almost always keep talking.
  if (turns < 2) return chance(0.05) ? 'ghost' : 'reply'

  if (behavior === 'angry') {
    // Blow-ups sometimes end the chat outright.
    if (chance(0.35)) return 'end'
  }
  if (behavior === 'dismissive') {
    if (chance(0.3)) return 'end'
    if (chance(0.2)) return 'ghost'
  }
  // Natural attrition as threads get long.
  if (turns >= 6 && chance(0.25)) return chance(0.5) ? 'end' : 'ghost'
  if (turns >= 10 && chance(0.5)) return 'end'

  return chance(0.08) ? 'ghost' : 'reply'
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
