'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  engineRunning,
  rollBehavior,
  startEngine,
  stopEngine,
} from '@/lib/client-sim/engine'
import { getSimStatus } from '@/lib/client-sim/status'
import { makePersona } from '@/lib/client-sim/content'
import { generateReply } from '@/lib/client-sim/generate'
import { analyzeDialogues, LearnError } from '@/lib/client-sim/learn'
import {
  countActiveThreads,
  getSettings as getSimSettings,
  listUsableChannels,
  sampleRealClientLines,
  updateSettings,
  type SettingsPatch,
} from '@/lib/client-sim/store'
import {
  clearAiLogs,
  listAiLogs,
  type AiLogLevel,
  type AiLogRow,
} from '@/lib/data/ai-log'
import type { LearnedProfile, SimPersona, SimStatus, SimTone } from '@/lib/client-sim/types'
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

/* ----------------------------- learning -------------------------------- */

export type SimLearnResult =
  | { ok: true; profile: LearnedProfile }
  | { ok: false; error: string }

/**
 * Analyze all real dialogues and persist a learned style profile. Returns a
 * tagged result so the UI can show a friendly message instead of a thrown
 * error (e.g. "not enough dialogues" / "no AI key").
 */
export async function simLearnAction(): Promise<SimLearnResult> {
  await guard()
  try {
    const profile = await analyzeDialogues()
    revalidatePath(ADMIN_PATH)
    return { ok: true, profile }
  } catch (err) {
    if (err instanceof LearnError) return { ok: false, error: err.message }
    return {
      ok: false,
      error: `Не удалось изучить диалоги: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
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

const SIM_TONES: SimTone[] = ['polite', 'neutral', 'rough', 'mixed']

/** Spin up a new persona and get their opening message. */
export async function simTestStartAction(input: {
  channelType: ChannelType
  /** Optional overrides; omitted → rolled autonomously (like the live engine). */
  aggression?: number
  tone?: SimTone
}): Promise<SimTestStart> {
  await guard()
  // Roll a fresh character each rehearsal so the sandbox mirrors the swarm's
  // "everyone is different" behaviour rather than a single fixed voice.
  const aggression =
    input.aggression !== undefined
      ? clampInt(input.aggression, 0, 100, 60)
      : Math.round((Math.random() * 100 + Math.random() * 100) / 2)
  const tone = input.tone ?? SIM_TONES[Math.floor(Math.random() * SIM_TONES.length)]
  const persona = makePersona(input.channelType, aggression, tone)
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

/* ------------------------- logs (simulator only) ------------------------ */
/*
 * The secret simulator's OWN activity log — completely separate from the AI
 * manager's log in the normal admin panel. Reads are scoped to 'sim' so the two
 * streams can never mix, and every action runs behind the same admin + god
 * passcode guard as the rest of this file.
 */

export interface SimDiagnostics {
  enabled: boolean
  engineRunning: boolean
  usableChannels: number
  activeThreads: number
}

/** Health snapshot for the simulator (drives the god-panel banner). */
export async function simDiagnosticsAction(): Promise<SimDiagnostics> {
  await guard()
  const [settings, activeThreads] = await Promise.all([
    getSimSettings(),
    countActiveThreads().catch(() => 0),
  ])
  const channels = await listUsableChannels(settings.channelIds).catch(() => [])
  return {
    enabled: settings.enabled,
    engineRunning: engineRunning(),
    usableChannels: channels.length,
    activeThreads,
  }
}

/** Tail the simulator activity log (scope 'sim' only). */
export async function simLogsAction(opts?: {
  level?: AiLogLevel | 'all'
  limit?: number
}): Promise<AiLogRow[]> {
  await guard()
  return listAiLogs({
    scope: 'sim',
    level: opts?.level ?? 'all',
    limit: opts?.limit ?? 200,
  })
}

/** Clear the simulator activity log (does not touch the AI-manager log). */
export async function simClearLogsAction(): Promise<void> {
  await guard()
  await clearAiLogs('sim')
}
