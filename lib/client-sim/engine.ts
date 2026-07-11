import type { SimState, SimThreadRow } from './types'
import { chance, makePersona, randInt } from './content'
import { type Behavior, generateReply } from './generate'
import { ensureLock, releaseLock } from './lock'
import {
  bumpRepliesTotal,
  claimDueThreads,
  claimSpawnSlot,
  countActiveThreads,
  createSimConversation,
  findThreadsAwaitingReaction,
  getSettings,
  getTranscript,
  insertInboundMessage,
  listUsableChannels,
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
  console.log('[v0][client-sim] engine started')
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
  console.log('[v0][client-sim] engine stopped')
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

    await maybeSpawn(settings.channelIds, settings.aggression, settings.maxThreads, {
      spawnMinSec: settings.spawnMinSec,
      spawnMaxSec: settings.spawnMaxSec,
    })
    await scheduleManagerReactions(settings.replyMinSec, settings.replyMaxSec)
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
  aggression: number,
  maxThreads: number,
  cadence: { spawnMinSec: number; spawnMaxSec: number },
): Promise<void> {
  const active = await countActiveThreads()
  if (active >= maxThreads) return

  let nextDelay = randInt(cadence.spawnMinSec, cadence.spawnMaxSec)
  // Real traffic isn't metronomic: now and then nobody writes for a while.
  // ~15% of the time stretch the next gap 2–4x to fake a quiet stretch, and a
  // rare ~5% "burst" shrinks it so a couple of people show up close together.
  if (chance(0.15)) nextDelay = Math.round(nextDelay * randInt(2, 4))
  else if (chance(0.05)) nextDelay = Math.max(15, Math.round(nextDelay * 0.3))

  // Atomically claim the spawn slot; only the winner proceeds.
  const won = await claimSpawnSlot(nextDelay)
  if (!won) return

  const channels = await listUsableChannels(channelIds)
  if (channels.length === 0) return

  const channel: SimChannel = pick(channels)
  const persona = makePersona(channel.type as ChannelType, aggression)
  const conversationId = await createSimConversation(channel, persona)

  // Opening line, sent right away (the thread's next_run_at was set to now()).
  const body = await generateReply({ persona, history: [], behavior: 'open' })
  await insertInboundMessage(conversationId, persona.name, body)
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
async function scheduleManagerReactions(
  replyMinSec: number,
  replyMaxSec: number,
): Promise<void> {
  const pending = await findThreadsAwaitingReaction(25)
  for (const p of pending) {
    // Sometimes a real person just... doesn't answer for a long while.
    const ignoreRoll = chance(0.12)
    const delay = ignoreRoll
      ? randInt(replyMaxSec * 3, replyMaxSec * 8)
      : randInt(replyMinSec, replyMaxSec)
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

  const body = await generateReply({ persona, history, behavior })
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
function rollBehavior(
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
  if (/подозрительн|осторожн/.test(temper)) weights.dismissive += 3
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
