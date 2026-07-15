'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  addLesson,
  countConversationsAwaitingAi,
  countLessons,
  deleteLesson,
  engageAiEverywhere,
  getAiAssistSettings,
  listBrainLessons,
  listLessons,
  listTrainableAccounts,
  sampleAccountDialogsForTraining,
  sampleTrainingConversations,
  savePlaybook,
  updateAiAssistSettings,
  type AiAssistLesson,
  type AiAssistSettings,
  type TrainableAccount,
  type TrainingSample,
} from '@/lib/data/ai-assist'
import { kickstartAwaitingConversations } from '@/lib/autopilot/runtime'
import {
  distillPlaybook,
  distillPlaybookFromDialogs,
  generateManagerReply,
  isBrainConfigured,
} from '@/lib/ai/manager-brain'
import {
  clearAiLogs,
  listAiLogs,
  type AiLogLevel,
  type AiLogRow,
} from '@/lib/data/ai-log'

/**
 * Server actions backing the admin «ИИ» tab: shared assistant settings, the
 * chat trainer, and the training-lesson corpus. Admin-only — every action
 * re-checks `requireAdmin()` because each is a standalone POST endpoint.
 *
 * The knowledge base is shared across all managers (product decision), so there
 * are no per-manager scopes here.
 */

const AI_PATH = '/admin/ai'

/** Current shared settings + a small dashboard snapshot. */
export async function aiSettingsAction(): Promise<{
  settings: AiAssistSettings
  configured: boolean
  lessonCount: number
}> {
  await requireAdmin()
  const [settings, lessonCount] = await Promise.all([
    getAiAssistSettings(),
    countLessons(),
  ])
  return { settings, configured: isBrainConfigured(), lessonCount }
}

/** Update tone / persona / master switch. */
export async function aiUpdateSettingsAction(patch: {
  enabled?: boolean
  tone?: string
  persona?: string
}): Promise<AiAssistSettings> {
  await requireAdmin()
  const next = await updateAiAssistSettings(patch)
  revalidatePath(AI_PATH)
  return next
}

/**
 * "Включить ИИ во всех диалогах". Flips the master switch on, resets every
 * conversation except «Передан» to «Отписка» with the AI un-paused, then kicks
 * off the FIRST batch of unanswered dialogues. Returns the initial waiting
 * count so the client can loop `aiKickstartBatchAction` until the backlog is
 * drained. Admin-only.
 */
export async function aiEngageAllAction(): Promise<{
  affected: number
  kicked: number
  remaining: number
}> {
  await requireAdmin()
  const { affected } = await engageAiEverywhere()
  const { kicked, remaining } = await kickstartAwaitingConversations(15)
  revalidatePath(AI_PATH)
  return { affected, kicked, remaining }
}

/**
 * Process one more batch of dialogues awaiting an AI reply. Called repeatedly by
 * the client after `aiEngageAllAction` until `remaining` reaches 0 (or stops
 * decreasing). Kept small per call to avoid request timeouts and to pace the
 * gateway. Admin-only.
 */
export async function aiKickstartBatchAction(): Promise<{
  kicked: number
  remaining: number
}> {
  await requireAdmin()
  return kickstartAwaitingConversations(15)
}

/** Count of dialogues still waiting on an AI reply. */
export async function aiAwaitingCountAction(): Promise<number> {
  await requireAdmin()
  return countConversationsAwaitingAi()
}

/** List recent training lessons. */
export async function aiListLessonsAction(): Promise<AiAssistLesson[]> {
  await requireAdmin()
  return listLessons(100)
}

/** Sample real conversations to practise on. */
export async function aiSampleConversationsAction(): Promise<TrainingSample[]> {
  await requireAdmin()
  return sampleTrainingConversations(8)
}

/* --------------------------- Train on an account -------------------------- */

/** Messaging accounts the admin can point the trainer at. */
export async function aiTrainableAccountsAction(): Promise<TrainableAccount[]> {
  await requireAdmin()
  return listTrainableAccounts()
}

/**
 * "Обучить ИИ на аккаунте": read the account's real manager↔client dialogs,
 * learn its selling style, and fold it into the shared knowledge base:
 *  1) store the strongest client→manager exchanges as few-shot "good answer"
 *     lessons (so replies mimic this account's real voice), and
 *  2) re-distill the playbook from BOTH the transcripts and the lesson corpus.
 *
 * Best-effort and additive — a gateway failure never wipes existing training.
 * Returns a short summary + refreshed settings/lessons for the UI.
 */
export async function aiTrainOnAccountAction(input: {
  channelId: string
}): Promise<{
  learnedExchanges: number
  playbookSize: number
  dialogsAnalysed: number
  settings: AiAssistSettings
  lessons: AiAssistLesson[]
}> {
  await requireAdmin()
  const channelId = input.channelId?.trim()
  if (!channelId) throw new Error('no_account')

  const { transcripts, exchanges } =
    await sampleAccountDialogsForTraining(channelId, 40)
  if (transcripts.length === 0) {
    throw new Error('no_dialogs')
  }

  // 1) Store real exchanges as style lessons (dedupe-friendly: addLesson is a
  // plain insert, so cap how many we add per run to keep the corpus focused).
  let learnedExchanges = 0
  for (const ex of exchanges.slice(0, 30)) {
    await addLesson({
      situation: ex.situation,
      draft: '',
      corrected: ex.corrected,
      note: 'Обучение на аккаунте: реальный ответ менеджера',
    })
    learnedExchanges++
  }

  // 2) Re-distill the playbook from the account's transcripts, merged with the
  // existing lesson-based playbook so prior training is preserved, not replaced.
  const settingsBefore = await getAiAssistSettings()
  let playbook = settingsBefore.playbook
  try {
    const fromDialogs = await distillPlaybookFromDialogs(
      transcripts,
      settingsBefore.persona,
    )
    const fromLessons = await distillPlaybook(
      await listBrainLessons(60),
      settingsBefore.persona,
    )
    const merged = Array.from(
      new Set(
        [...fromDialogs, ...fromLessons]
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ).slice(0, 20)
    if (merged.length > 0) {
      playbook = merged
      await savePlaybook(playbook)
    }
  } catch {
    // Keep the prior playbook; the exchange lessons above are already saved.
  }

  const [settings, lessons] = await Promise.all([
    getAiAssistSettings(),
    listLessons(100),
  ])
  revalidatePath(AI_PATH)
  return {
    learnedExchanges,
    playbookSize: playbook.length,
    dialogsAnalysed: transcripts.length,
    settings,
    lessons,
  }
}

/**
 * Ask the AI to suggest a reply for a given situation/history, using the
 * current shared knowledge base. Returns null when the AI is unavailable.
 */
export async function aiSuggestReplyAction(input: {
  history: Array<{ role: 'client' | 'manager'; body: string }>
}): Promise<string | null> {
  await requireAdmin()
  const [settings, lessons] = await Promise.all([
    getAiAssistSettings(),
    listBrainLessons(12),
  ])
  return generateManagerReply({
    persona: settings.persona,
    tone: settings.tone,
    playbook: settings.playbook,
    lessons,
    history: input.history,
  })
}

/**
 * Save an admin correction as a training lesson, then re-distill the playbook
 * so future replies immediately benefit. Returns the refreshed settings +
 * lessons for the UI.
 */
export async function aiSaveLessonAction(input: {
  situation: string
  draft: string
  corrected: string
  note: string
}): Promise<{ settings: AiAssistSettings; lessons: AiAssistLesson[] }> {
  await requireAdmin()
  const corrected = input.corrected.trim()
  if (!corrected) throw new Error('empty_correction')

  await addLesson({
    situation: input.situation.trim(),
    draft: input.draft.trim(),
    corrected,
    note: input.note.trim(),
  })

  // Re-distill the playbook from the full corpus (best-effort — a failure here
  // must not lose the lesson we just saved).
  try {
    const settings = await getAiAssistSettings()
    const brainLessons = await listBrainLessons(60)
    const playbook = await distillPlaybook(brainLessons, settings.persona)
    await savePlaybook(playbook)
  } catch {
    // playbook stays as-is; the lesson is still stored and used by recency.
  }

  const [settings, lessons] = await Promise.all([
    getAiAssistSettings(),
    listLessons(100),
  ])
  revalidatePath(AI_PATH)
  return { settings, lessons }
}

/** Remove a training lesson. */
export async function aiDeleteLessonAction(id: string): Promise<void> {
  await requireAdmin()
  await deleteLesson(id)
  revalidatePath(AI_PATH)
}

/* ------------------------- Logs (AI manager only) ------------------------- */

/**
 * Health snapshot for the AI MANAGER only (the assistant that talks to real
 * clients). Deliberately contains ZERO simulator data — the secret client
 * simulator is a god-panel feature and must never surface in the normal admin
 * panel. Answers "почему ИИ молчит" at a glance: missing key or master switch.
 */
export interface AiDiagnostics {
  aiConfigured: boolean
  aiMasterEnabled: boolean
}

export async function aiDiagnosticsAction(): Promise<AiDiagnostics> {
  await requireAdmin()
  const aiSettings = await getAiAssistSettings()
  return {
    aiConfigured: isBrainConfigured(),
    aiMasterEnabled: aiSettings.enabled,
  }
}

/**
 * Tail the AI-manager activity log. Scoped to 'ai' so simulator activity can
 * never appear here. `sinceId` enables cheap incremental polling.
 */
export async function aiLogsAction(opts?: {
  sinceId?: string | null
  level?: AiLogLevel | 'all'
  limit?: number
}): Promise<AiLogRow[]> {
  await requireAdmin()
  return listAiLogs({
    scope: 'ai',
    sinceId: opts?.sinceId ?? null,
    level: opts?.level ?? 'all',
    limit: opts?.limit ?? 200,
  })
}

/** Clear the AI-manager activity log (does not touch the simulator log). */
export async function aiClearLogsAction(): Promise<void> {
  await requireAdmin()
  await clearAiLogs('ai')
}
