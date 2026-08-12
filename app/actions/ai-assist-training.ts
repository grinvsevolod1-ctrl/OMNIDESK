'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  addLesson,
  addLessonIfNew,
  addManualCorrection,
  buildTrainingCorpusForConversationIds,
  countManualCorrections,
  deleteLesson,
  deleteManualCorrection,
  getAiAssistSettings,
  getDialogMessagesForReview,
  listAccountReviewDialogs,
  listAccountTwoWayConversationIds,
  listBrainLessons,
  listLessons,
  listManualCorrections,
  listTrainableAccounts,
  sampleTrainingConversations,
  savePlaybook,
  type AiAssistLesson,
  type AiAssistSettings,
  type ManualCorrection,
  type ReviewDialog,
  type ReviewMessage,
  type TrainableAccount,
  type TrainingSample,
} from '@/lib/data/ai-assist'
import {
  distillPlaybook,
  distillPlaybookFromDialogs,
  generateManagerReply,
} from '@/lib/ai/manager-brain'
import { directiveTexts } from '@/lib/data/ai-directives'
import {
  AI_PATH,
  LESSON_LIST_LIMIT,
  PLAYBOOK_DISTILL_FROM_ACCOUNT,
  PLAYBOOK_DISTILL_FROM_LESSON,
  SUGGEST_LESSON_CONTEXT,
} from './ai-assist-shared'

/**
 * Training / lesson / correction actions for the admin «ИИ» tab: the account
 * trainer, the chat trainer, per-message corrections and the lesson corpus.
 * Admin-only — every action re-checks `requireAdmin()`. Settings and
 * enrollment actions live in ai-assist-settings.ts; both are re-exported by
 * the ai-assist.ts barrel.
 */

/** List recent training lessons. */
export async function aiListLessonsAction(): Promise<AiAssistLesson[]> {
  await requireAdmin()
  return listLessons(LESSON_LIST_LIMIT)
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
 * How many dialogs to fold into ONE playbook-distillation call. The account is
 * processed in batches of this size (each batch is a separate gateway call);
 * every batch's rules are accumulated and merged at the end. Env-overridable.
 */
const TRAIN_BATCH = Math.max(
  5,
  Number.parseInt(process.env.AI_TRAIN_BATCH || '40', 10) || 40,
)

/**
 * Hard upper bound on dialogs processed in a single training run. A server
 * action runs inside a bounded serverless time budget, so training on an
 * account with thousands of dialogs must NOT try to process them all in one
 * request (it would time out and lose everything). We take the most recent
 * `TRAIN_MAX_DIALOGS` (ids come newest-first) — the freshest, most relevant
 * material — and report honestly how many of the total were analysed. Running
 * the action again continues to enrich the corpus (lessons are additive and
 * deduped). Env-overridable for larger deployments/plans.
 */
const TRAIN_MAX_DIALOGS = Math.max(
  TRAIN_BATCH,
  Number.parseInt(process.env.AI_TRAIN_MAX_DIALOGS || '200', 10) || 200,
)

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
  totalDialogs: number
  settings: AiAssistSettings
  lessons: AiAssistLesson[]
}> {
  await requireAdmin()
  const channelId = input.channelId?.trim()
  if (!channelId) throw new Error('no_account')

  // Read the account's two-way dialogs (newest-first) and cap the workload to
  // the most recent TRAIN_MAX_DIALOGS so the run always fits the serverless
  // time budget. `totalDialogs` is reported so the UI can be honest about how
  // much of the account was covered in this pass.
  const allIds = await listAccountTwoWayConversationIds(channelId)
  const totalDialogs = allIds.length
  if (totalDialogs === 0) {
    throw new Error('no_dialogs')
  }
  const ids = allIds.slice(0, TRAIN_MAX_DIALOGS)

  const settingsBefore = await getAiAssistSettings()
  let learnedExchanges = 0
  let dialogsAnalysed = 0
  // Rules harvested from every batch, deduped as we go.
  const ruleSet = new Set<string>()

  // Process the capped set in batches to keep each gateway call bounded.
  for (let i = 0; i < ids.length; i += TRAIN_BATCH) {
    const batchIds = ids.slice(i, i + TRAIN_BATCH)
    const { transcripts, exchanges } =
      await buildTrainingCorpusForConversationIds(batchIds)
    if (transcripts.length === 0) continue
    dialogsAnalysed += transcripts.length

    // 1) Store this batch's real exchanges as style lessons (idempotent, so
    // re-training the same account never duplicates the corpus).
    for (const ex of exchanges) {
      const inserted = await addLessonIfNew({
        situation: ex.situation,
        corrected: ex.corrected,
        note: 'Обучение на аккаунте: реальный ответ менеджера',
      })
      if (inserted) learnedExchanges++
    }

    // 2) Distill this batch of transcripts into playbook rules and accumulate.
    try {
      const fromDialogs = await distillPlaybookFromDialogs(
        transcripts,
        settingsBefore.persona,
      )
      for (const r of fromDialogs) {
        const t = r.trim()
        if (t) ruleSet.add(t)
      }
    } catch {
      // Skip this batch's distillation; its lessons are already saved above.
    }
  }

  // 3) Merge batch rules with a fresh distillation of the (now larger) lesson
  // corpus, then keep the strongest ~24 so the always-injected playbook stays
  // compact. Prior training is preserved because lessons are never deleted.
  const settingsAfterLessons = await getAiAssistSettings()
  let playbook = settingsAfterLessons.playbook
  try {
    const fromLessons = await distillPlaybook(
      await listBrainLessons(PLAYBOOK_DISTILL_FROM_ACCOUNT),
      settingsAfterLessons.persona,
    )
    const merged = Array.from(
      new Set(
        [...ruleSet, ...fromLessons, ...playbook]
          .map((l) => l.trim())
          .filter(Boolean),
      ),
    ).slice(0, 24)
    if (merged.length > 0) {
      playbook = merged
      await savePlaybook(playbook)
    }
  } catch {
    // Keep the prior playbook; exchange lessons above are already saved.
  }

  const [settings, lessons] = await Promise.all([
    getAiAssistSettings(),
    listLessons(LESSON_LIST_LIMIT),
  ])
  revalidatePath(AI_PATH)
  return {
    learnedExchanges,
    playbookSize: playbook.length,
    dialogsAnalysed,
    totalDialogs,
    settings,
    lessons,
  }
}

/* -------------------- Interactive per-message corrections ------------------ */

/** Dialogs of an account for the review/correction UI (newest first). */
export async function aiReviewDialogsAction(input: {
  channelId: string
}): Promise<ReviewDialog[]> {
  await requireAdmin()
  const channelId = input.channelId?.trim()
  if (!channelId) return []
  return listAccountReviewDialogs(channelId)
}

/** The full message list of one dialog, for selecting a message to correct. */
export async function aiReviewMessagesAction(input: {
  channelId: string
  conversationId: string
}): Promise<ReviewMessage[]> {
  await requireAdmin()
  const channelId = input.channelId?.trim()
  const conversationId = input.conversationId?.trim()
  if (!channelId || !conversationId) return []
  return getDialogMessagesForReview(channelId, conversationId)
}

/**
 * Save a hand-written correction on a specific message. Builds a short context
 * window (the turns leading up to the selected message) so the AI knows exactly
 * where the rule applies, then stores it forever in the always-injected
 * manual-corrections store. Returns the refreshed corrections list.
 */
export async function aiAddCorrectionAction(input: {
  channelId: string
  conversationId: string
  messageId: string
  accountLabel: string
  instruction: string
}): Promise<{ corrections: ManualCorrection[]; count: number }> {
  await requireAdmin()
  const channelId = input.channelId?.trim()
  const conversationId = input.conversationId?.trim()
  const messageId = input.messageId?.trim()
  const instruction = input.instruction?.trim()
  if (!channelId || !conversationId || !messageId) {
    throw new Error('bad_request')
  }
  if (!instruction) throw new Error('empty_instruction')

  const messages = await getDialogMessagesForReview(channelId, conversationId)
  const idx = messages.findIndex((m) => m.id === messageId)
  if (idx === -1) throw new Error('message_not_found')
  const target = messages[idx]

  // Context = up to 6 turns ending at the selected message, speaker-labelled.
  const windowStart = Math.max(0, idx - 5)
  const context = messages
    .slice(windowStart, idx + 1)
    .map((m) => {
      const who =
        m.role === 'client'
          ? 'Клиент'
          : m.role === 'ai'
            ? 'ИИ-менеджер'
            : 'Менеджер'
      return `${who}: ${m.body}`
    })
    .join('\n')

  await addManualCorrection({
    conversationId,
    channelId,
    accountLabel: input.accountLabel?.trim() || '',
    context,
    targetRole: target.role,
    targetMessage: target.body,
    instruction,
  })

  const [corrections, count] = await Promise.all([
    listManualCorrections(200),
    countManualCorrections(),
  ])
  revalidatePath(AI_PATH)
  return { corrections, count }
}

/** All saved manual corrections (management panel). */
export async function aiListCorrectionsAction(): Promise<{
  corrections: ManualCorrection[]
  count: number
}> {
  await requireAdmin()
  const [corrections, count] = await Promise.all([
    listManualCorrections(200),
    countManualCorrections(),
  ])
  return { corrections, count }
}

/** Delete one manual correction. */
export async function aiDeleteCorrectionAction(input: {
  id: string
}): Promise<{ corrections: ManualCorrection[]; count: number }> {
  await requireAdmin()
  const id = input.id?.trim()
  if (!id) throw new Error('bad_request')
  await deleteManualCorrection(id)
  const [corrections, count] = await Promise.all([
    listManualCorrections(200),
    countManualCorrections(),
  ])
  revalidatePath(AI_PATH)
  return { corrections, count }
}

/**
 * Ask the AI to suggest a reply for a given situation/history, using the
 * current shared knowledge base. Returns null when the AI is unavailable.
 */
export async function aiSuggestReplyAction(input: {
  history: Array<{ role: 'client' | 'manager'; body: string }>
}): Promise<string | null> {
  await requireAdmin()
  const [settings, lessons, directives] = await Promise.all([
    getAiAssistSettings(),
    listBrainLessons(SUGGEST_LESSON_CONTEXT),
    directiveTexts(),
  ])
  return generateManagerReply(
    {
      persona: settings.persona,
      tone: settings.tone,
      playbook: settings.playbook,
      directives,
      lessons,
      aggressiveness: settings.aggressiveness,
      history: input.history,
    },
    undefined,
    {
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
    },
  )
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
    const brainLessons = await listBrainLessons(PLAYBOOK_DISTILL_FROM_LESSON)
    const playbook = await distillPlaybook(brainLessons, settings.persona)
    await savePlaybook(playbook)
  } catch {
    // playbook stays as-is; the lesson is still stored and used by recency.
  }

  const [settings, lessons] = await Promise.all([
    getAiAssistSettings(),
    listLessons(LESSON_LIST_LIMIT),
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
