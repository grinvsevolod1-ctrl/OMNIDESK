'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  countLessons,
  deleteKnowledge,
  enrollConversationAi,
  getAiAssistSettings,
  listAiEnrolledConversations,
  listEnrollableConversations,
  listKnowledge,
  unenrollConversationAi,
  updateAiAssistSettings,
  upsertKnowledge,
  type AiAssistSettings,
  type EnrollableConversation,
  type KnowledgeEntry,
} from '@/lib/data/ai-assist'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import {
  clearAiLogs,
  listAiLogs,
  type AiLogLevel,
  type AiLogRow,
} from '@/lib/data/ai-log'
import {
  listDirectives,
  type AiDirective,
} from '@/lib/data/ai-directives'
import { writeAudit } from '@/lib/data/audit'
import { AI_PATH, type AiDiagnostics } from './ai-assist-shared'

/**
 * Settings / knowledge-base / enrollment / diagnostics actions for the admin
 * «ИИ» tab. Admin-only — every action re-checks `requireAdmin()` because each
 * is a standalone POST endpoint. Training and correction actions live in
 * ai-assist-training.ts; both are re-exported by the ai-assist.ts barrel.
 *
 * The knowledge base is shared across all managers (product decision), so there
 * are no per-manager scopes here.
 */

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

/** Update tone / persona / master switch / model tuning. */
export async function aiUpdateSettingsAction(patch: {
  enabled?: boolean
  tone?: string
  persona?: string
  model?: string
  temperature?: number
  maxTokens?: number
  aggressiveness?: number
}): Promise<AiAssistSettings> {
  await requireAdmin()
  // Clamp tuning to the same bounds the DB constraints enforce, so a bad UI
  // value fails soft instead of throwing a constraint error.
  const clamped: typeof patch = { ...patch }
  if (typeof clamped.temperature === 'number') {
    clamped.temperature = Math.max(0, Math.min(2, clamped.temperature))
  }
  if (typeof clamped.maxTokens === 'number') {
    clamped.maxTokens = Math.max(50, Math.min(4000, Math.round(clamped.maxTokens)))
  }
  if (typeof clamped.aggressiveness === 'number') {
    clamped.aggressiveness = Math.max(0, Math.min(3, Math.round(clamped.aggressiveness)))
  }
  const next = await updateAiAssistSettings(clamped)
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'ai.settings.update',
    entityType: 'ai_settings',
    // Persona/tone can be long free text — record which fields changed, not
    // their full bodies, to keep audit rows small and secret-free.
    details: { fields: Object.keys(clamped) },
  })
  revalidatePath(AI_PATH)
  return next
}

/* --------------------------- RAG knowledge base ------------------------- */

/** List all knowledge entries for the admin management view. Admin-only. */
export async function aiListKnowledgeAction(): Promise<KnowledgeEntry[]> {
  await requireAdmin()
  return listKnowledge()
}

/**
 * Create or update a knowledge entry (embedding is computed server-side). The
 * content is required; a blank content is rejected so we never store an empty
 * chunk. Admin-only.
 */
export async function aiSaveKnowledgeAction(input: {
  id?: string
  title: string
  content: string
  enabled?: boolean
}): Promise<KnowledgeEntry> {
  await requireAdmin()
  const content = input.content.trim()
  if (!content) throw new Error('Содержание не может быть пустым.')
  const entry = await upsertKnowledge({
    id: input.id,
    title: input.title.trim(),
    content,
    enabled: input.enabled,
  })
  revalidatePath(AI_PATH)
  return entry
}

/** Delete a knowledge entry. Admin-only. */
export async function aiDeleteKnowledgeAction(id: string): Promise<void> {
  await requireAdmin()
  await deleteKnowledge(id)
  revalidatePath(AI_PATH)
}

/* ----------------------- Per-dialog AI enrollment ------------------------ */

/**
 * Real (non-simulated) dialogs the admin can enroll the AI into. Optional
 * text search over the contact name. Strict opt-in model: the AI only ever
 * participates in dialogs the admin explicitly picks here. Admin-only.
 */
export async function aiListEnrollableAction(input?: {
  search?: string
}): Promise<EnrollableConversation[]> {
  await requireAdmin()
  return listEnrollableConversations(input?.search ?? '')
}

/** Dialogs currently led by the AI (enrolled), newest first. Admin-only. */
export async function aiListEnrolledAction(): Promise<EnrollableConversation[]> {
  await requireAdmin()
  return listAiEnrolledConversations()
}

/**
 * Enroll the AI into one dialog. Stamps the enrollment cutoff so the AI only
 * acts on messages from now on (never replays the old backlog / drifts
 * off-topic). Refuses simulated dialogs. Returns the refreshed enrolled list.
 */
export async function aiEnrollAction(input: {
  conversationId: string
}): Promise<{ enrolled: EnrollableConversation[]; ok: boolean }> {
  await requireAdmin()
  const id = input.conversationId?.trim()
  if (!id) throw new Error('bad_request')
  const ok = await enrollConversationAi(id)
  revalidatePath(AI_PATH)
  return { enrolled: await listAiEnrolledConversations(), ok }
}

/** Remove the AI from one dialog (un-enroll). Returns the refreshed list. */
export async function aiUnenrollAction(input: {
  conversationId: string
}): Promise<{ enrolled: EnrollableConversation[]; ok: boolean }> {
  await requireAdmin()
  const id = input.conversationId?.trim()
  if (!id) throw new Error('bad_request')
  const ok = await unenrollConversationAi(id)
  revalidatePath(AI_PATH)
  return { enrolled: await listAiEnrolledConversations(), ok }
}

/**
 * List the co-pilot-managed directives (the mandate) for a READ-ONLY display in
 * the settings UI. Directives are created and edited through the co-pilot chat;
 * this action only lets the admin see what is currently in force.
 */
export async function aiListDirectivesAction(): Promise<AiDirective[]> {
  await requireAdmin()
  try {
    return await listDirectives()
  } catch {
    // Table may not exist before the directives migration has run.
    return []
  }
}

/* ------------------------- Logs (AI manager only) ------------------------- */

/**
 * Health snapshot for the AI MANAGER only (the assistant that talks to real
 * clients). Answers "почему ИИ молчит" at a glance: missing key or master
 * switch.
 */
export async function aiDiagnosticsAction(): Promise<AiDiagnostics> {
  await requireAdmin()
  const aiSettings = await getAiAssistSettings()
  return {
    aiConfigured: isBrainConfigured(),
    aiMasterEnabled: aiSettings.enabled,
  }
}

/**
 * Tail the AI-manager activity log. Scoped to 'ai'. `sinceId` enables cheap
 * incremental polling.
 */
export async function aiLogsAction(opts?: {
  sinceId?: string | null
  level?: AiLogLevel | 'all'
  limit?: number
}): Promise<AiLogRow[]> {
  await requireAdmin()
  return listAiLogs({
    sinceId: opts?.sinceId ?? null,
    level: opts?.level ?? 'all',
    limit: opts?.limit ?? 200,
  })
}

/** Clear the AI-manager activity log. */
export async function aiClearLogsAction(): Promise<void> {
  await requireAdmin()
  await clearAiLogs()
}
