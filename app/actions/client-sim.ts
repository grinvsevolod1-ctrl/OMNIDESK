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
  addSimCorrection,
  adoptConversations,
  CampaignUnavailableError,
  countActiveThreads,
  countSimCorrections,
  deleteSimCorrection,
  getSettings as getSimSettings,
  getSimDialogForReview,
  invalidateSimCorrectionsCache,
  listAdoptableConversations,
  listSimCorrections,
  listUsableChannels,
  releaseConversations,
  sampleRealClientLines,
  startCampaign,
  stopCampaign,
  updateSettings,
  type AdoptableConversation,
  type SettingsPatch,
  type SimCorrection,
  type SimReviewMessage,
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

/* ----------------------------- campaign -------------------------------- */

export type SimCampaignResult =
  | { ok: true; status: SimStatus }
  | { ok: false; error: string }

/**
 * Start a burst campaign: open `count` brand-new dialogues over the next
 * `hours`, paced so they arrive spread across the window (not all at once).
 * Turns the simulator on and starts the engine. Returns a tagged result so the
 * UI can show a friendly message when campaign mode isn't available (migration
 * 062 not applied) instead of a raw error.
 */
export async function simStartCampaignAction(input: {
  count: number
  hours: number
}): Promise<SimCampaignResult> {
  await guard()
  try {
    await startCampaign(input.count, input.hours)
    startEngine()
    revalidatePath(ADMIN_PATH)
    return { ok: true, status: await getSimStatus() }
  } catch (err) {
    if (err instanceof CampaignUnavailableError) {
      return { ok: false, error: err.message }
    }
    return {
      ok: false,
      error: `Не удалось запустить кампанию: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

/**
 * Stop the active campaign. `keepEnabled` (default true) leaves the simulator
 * running on its steady per-day rate; false switches it off entirely.
 */
export async function simStopCampaignAction(input?: {
  keepEnabled?: boolean
}): Promise<SimCampaignResult> {
  await guard()
  try {
    const keepEnabled = input?.keepEnabled ?? true
    await stopCampaign(keepEnabled)
    if (!keepEnabled) stopEngine()
    revalidatePath(ADMIN_PATH)
    return { ok: true, status: await getSimStatus() }
  } catch (err) {
    if (err instanceof CampaignUnavailableError) {
      return { ok: false, error: err.message }
    }
    return {
      ok: false,
      error: `Не удалось остановить кампанию: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
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

/* -------------------- adopt existing / real dialogues ------------------- */
/*
 * The simulator normally only continues conversations it created itself. These
 * two actions let an admin hand it EXISTING dialogues (organic ones, or any that
 * predate an update): list every manager-routed conversation, then register the
 * chosen ones so the engine revives and continues them in-character on a
 * randomised, staggered schedule.
 */

/** All manager-routed conversations, for the "continue existing dialogues" table. */
export async function simListAdoptableAction(): Promise<AdoptableConversation[]> {
  await guard()
  return listAdoptableConversations()
}

export interface SimAdoptResult {
  adopted: number
  skipped: number
}

/**
 * Register the selected conversations as simulator threads. `spreadMinutes`
 * controls how widely their first resumed turn is scattered across time (so they
 * never all fire at once). It is clamped BELOW the engine's 3h ghost-reaper
 * window so a scheduled turn always fires before the thread could be retired.
 */
export async function simAdoptConversationsAction(input: {
  conversationIds: string[]
  spreadMinutes?: number
}): Promise<SimAdoptResult> {
  await guard()
  const ids = (input.conversationIds ?? []).filter(Boolean)
  if (ids.length === 0) return { adopted: 0, skipped: 0 }

  // Roll a character voice for the adopted crowd from the live settings, so the
  // revived dialogues match the tone the operator configured.
  const settings = await getSimSettings()
  const spread = clampInt(input.spreadMinutes ?? 120, 1, 165, 120)

  const result = await adoptConversations(ids, {
    aggression: settings.aggression,
    tone: settings.tone,
    minDelaySec: 20,
    maxDelaySec: spread * 60,
  })

  // A restart-safe engine picks these up on its next tick; make sure it's
  // running if the simulator is enabled, so adoption "just works".
  if (settings.enabled) startEngine()

  revalidatePath(ADMIN_PATH)
  return result
}

export interface SimReleaseResult {
  released: number
}

/**
 * Remove the selected conversations from the simulator — the inverse of adopt.
 * The bot immediately stops driving them; the real conversation and its whole
 * message history stay untouched, so an adopted real dialogue is handed straight
 * back to its human manager.
 */
export async function simReleaseConversationsAction(input: {
  conversationIds: string[]
}): Promise<SimReleaseResult> {
  await guard()
  const ids = (input.conversationIds ?? []).filter(Boolean)
  if (ids.length === 0) return { released: 0 }

  const result = await releaseConversations(ids)
  revalidatePath(ADMIN_PATH)
  return result
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
  // No template fallback — surface the failure so the UI shows a clear toast.
  if (!opening) {
    throw new Error('AI unavailable: не удалось сгенерировать реплику клиента')
  }
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
  // No template fallback — surface the failure so the UI shows a clear toast.
  if (!reply) {
    throw new Error('AI unavailable: не удалось сгенерировать реплику клиента')
  }
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

/* ---------------------- training / corrections -------------------------- */
/*
 * The secret-panel mirror of the manager's manual corrections. The admin opens
 * one of the simulator's OWN dialogs, flags a message ("here you're wrong"),
 * and writes what a real person would do instead. The rule is injected into
 * every future simulator generation — completely separate from the AI manager's
 * training corpus.
 */

/** Full transcript of a simulated dialog for the review pane (sim dialogs only). */
export async function simDialogForReviewAction(
  conversationId: string,
): Promise<SimReviewMessage[]> {
  await guard()
  if (!conversationId) return []
  return getSimDialogForReview(conversationId)
}

/** Save a "here you're wrong" correction on a simulator message. */
export async function simAddCorrectionAction(input: {
  conversationId: string | null
  context: string
  targetMessage: string
  instruction: string
}): Promise<SimCorrection> {
  await guard()
  const instruction = input.instruction.trim()
  if (!instruction) {
    throw new Error('Пустое правило: опишите, что не так и как надо.')
  }
  const saved = await addSimCorrection({
    conversationId: input.conversationId,
    context: input.context.trim(),
    targetMessage: input.targetMessage.trim(),
    instruction,
  })
  // The generator reads a cached rule set — drop it so the new rule applies now.
  invalidateSimCorrectionsCache()
  revalidatePath(ADMIN_PATH)
  return saved
}

/** All simulator corrections, newest first, plus the total count. */
export async function simListCorrectionsAction(): Promise<{
  items: SimCorrection[]
  total: number
}> {
  await guard()
  const [items, total] = await Promise.all([
    listSimCorrections(200),
    countSimCorrections(),
  ])
  return { items, total }
}

/** Delete a simulator correction and refresh the injected rule set. */
export async function simDeleteCorrectionAction(id: string): Promise<void> {
  await guard()
  if (!id) return
  await deleteSimCorrection(id)
  invalidateSimCorrectionsCache()
  revalidatePath(ADMIN_PATH)
}
