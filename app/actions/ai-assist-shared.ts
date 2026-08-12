/**
 * Shared constants for the ai-assist action modules. NOT 'use server' — a
 * 'use server' module may only export async functions, so plain values live
 * here and are imported by ai-assist-settings.ts / ai-assist-training.ts.
 */

/** The admin AI tab path, revalidated after every mutation. */
export const AI_PATH = '/admin/ai'

/**
 * Corpus sizes for the lesson/playbook operations. Named so each limit's intent
 * is explicit (they differ on purpose): the admin list shows more, while the
 * always-injected playbook is distilled from a tighter, higher-signal window.
 */
export const LESSON_LIST_LIMIT = 100 // admin-visible lessons returned to the UI
export const PLAYBOOK_DISTILL_FROM_ACCOUNT = 80 // lessons folded in when training on an account
export const PLAYBOOK_DISTILL_FROM_LESSON = 60 // lessons folded in after one manual lesson
export const SUGGEST_LESSON_CONTEXT = 12 // lessons used to suggest a trainer reply

/** Health snapshot for the AI manager (see aiDiagnosticsAction). */
export interface AiDiagnostics {
  aiConfigured: boolean
  aiMasterEnabled: boolean
}
