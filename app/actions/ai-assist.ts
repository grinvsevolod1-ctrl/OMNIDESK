'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  addLesson,
  countLessons,
  deleteLesson,
  getAiAssistSettings,
  listBrainLessons,
  listLessons,
  sampleTrainingConversations,
  savePlaybook,
  updateAiAssistSettings,
  type AiAssistLesson,
  type AiAssistSettings,
  type TrainingSample,
} from '@/lib/data/ai-assist'
import {
  distillPlaybook,
  generateManagerReply,
  isBrainConfigured,
} from '@/lib/ai/manager-brain'

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
