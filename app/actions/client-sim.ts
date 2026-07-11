'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { rollBehavior, startEngine, stopEngine } from '@/lib/client-sim/engine'
import { getSimStatus } from '@/lib/client-sim/status'
import { makePersona } from '@/lib/client-sim/content'
import { generateReply } from '@/lib/client-sim/generate'
import { sampleRealClientLines, updateSettings, type SettingsPatch } from '@/lib/client-sim/store'
import type { SimPersona, SimStatus } from '@/lib/client-sim/types'
import type { ChannelType } from '@/lib/types'

/**
 * Server actions backing the "Simulator" tab of the God-mode console.
 *
 * Two independent guards run on every call: `requireAdmin()` (the account must
 * be an admin) AND `isGodUnlocked()` (the secret passcode gate). A server action
 * is a standalone POST endpoint, so re-checking here — not just on the page — is
 * what actually protects the simulator from direct invocation.
 */

const ADMIN_PATH = '/wijegniwjgwjog'

async function guard(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) {
    throw new Error('forbidden')
  }
}

/** Current live status snapshot for the dashboard. */
export async function simStatusAction(): Promise<SimStatus> {
  await guard()
  return getSimStatus()
}

/** Update any subset of the simulator settings. */
export async function simUpdateSettingsAction(
  patch: SettingsPatch,
): Promise<SimStatus> {
  await guard()
  await updateSettings(patch)
  revalidatePath(ADMIN_PATH)
  return getSimStatus()
}

/**
 * Turn the simulator on/off. Enabling persists the flag AND starts the engine
 * in this process; the flag also means instrumentation resumes it after any
 * restart, so it keeps running in the background with the panel closed.
 */
export async function simToggleAction(enabled: boolean): Promise<SimStatus> {
  await guard()
  await updateSettings({ enabled })
  if (enabled) {
    startEngine()
  } else {
    stopEngine()
  }
  revalidatePath(ADMIN_PATH)
  return getSimStatus()
}

/* --------------------------- test sandbox ------------------------------- */
/*
 * A throwaway, in-memory rehearsal: the admin plays the manager and chats with
 * a freshly generated persona. It NEVER writes to conversations/messages/
 * sim_threads — nothing here is persisted or visible to real managers. It only
 * reads real client lines (for style reference) and calls the LLM.
 */

export interface SimTestLine {
  role: 'manager' | 'client'
  body: string
}

export interface SimTestStart {
  persona: SimPersona
  opening: string
}

/** Spin up a new persona and get their opening message. */
export async function simTestStartAction(input: {
  channelType: ChannelType
  aggression: number
}): Promise<SimTestStart> {
  await guard()
  const aggression = clampInt(input.aggression, 0, 100, 60)
  const persona = makePersona(input.channelType, aggression)
  const referenceLines = await sampleRealClientLines(input.channelType)
  const opening = await generateReply({
    persona,
    history: [],
    behavior: 'open',
    referenceLines,
  })
  return { persona, opening }
}

/** Continue the rehearsal: given the persona + transcript, get the next reply. */
export async function simTestReplyAction(input: {
  persona: SimPersona
  history: SimTestLine[]
}): Promise<{ reply: string }> {
  await guard()
  const { persona, history } = input
  // Count client turns so behaviour escalation matches the real engine.
  const clientTurns = history.filter((l) => l.role === 'client').length
  const behavior = rollBehavior(
    persona.temper,
    persona.style.profanity,
    clientTurns,
  )
  const referenceLines = await sampleRealClientLines(persona.channelType)
  const reply = await generateReply({ persona, history, behavior, referenceLines })
  return { reply }
}

function clampInt(v: number, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(v))
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}
