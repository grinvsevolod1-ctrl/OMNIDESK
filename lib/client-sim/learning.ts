/**
 * Simulator corrections layer. Covers admin 'here you're wrong' corrections
 * and the correction-rule in-process cache consumed by the generator.
 * Depends only on the DB layer and shared types.
 */

import { query } from '@/lib/db'

/* ---------------------- simulator training corrections ------------------ */
/*
 * The secret-panel mirror of the manager's ai_manual_corrections (063). The
 * admin flags a specific simulator message ("here you're wrong — a real person
 * wouldn't write this") and the rule is injected into EVERY future simulator
 * prompt. Entirely separate table + code path from the manager brain, so the
 * two AIs never share training data.
 */

export interface SimCorrection {
  id: string
  createdAt: string
  conversationId: string | null
  context: string
  targetMessage: string
  instruction: string
}

interface SimCorrectionRow {
  id: string
  created_at: string | Date
  conversation_id: string | null
  context: string
  target_message: string
  instruction: string
}

function mapSimCorrection(r: SimCorrectionRow): SimCorrection {
  return {
    id: r.id,
    createdAt: new Date(r.created_at).toISOString(),
    conversationId: r.conversation_id,
    context: r.context,
    targetMessage: r.target_message,
    instruction: r.instruction,
  }
}

/** Record a "here you're wrong" correction on a simulator message. */
export async function addSimCorrection(input: {
  conversationId: string | null
  context: string
  targetMessage: string
  instruction: string
}): Promise<SimCorrection> {
  const rows = await query<SimCorrectionRow>(
    `INSERT INTO sim_manual_corrections
       (conversation_id, context, target_message, instruction)
     VALUES ($1, $2, $3, $4)
     RETURNING id, created_at, conversation_id, context, target_message, instruction`,
    [
      input.conversationId,
      input.context,
      input.targetMessage,
      input.instruction,
    ],
  )
  return mapSimCorrection(rows[0])
}

/** All simulator corrections, newest first (for the secret-panel list). */
export async function listSimCorrections(limit = 200): Promise<SimCorrection[]> {
  const rows = await query<SimCorrectionRow>(
    `SELECT id, created_at, conversation_id, context, target_message, instruction
       FROM sim_manual_corrections
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(1000, limit))],
  )
  return rows.map(mapSimCorrection)
}

/**
 * Simulator corrections rendered as strict, ready-to-inject rule strings.
 * Newest-first and generously capped — always injected into the generation
 * prompt, never distilled away, so the simulator never repeats a flagged
 * mistake.
 */
export async function listSimCorrectionRules(limit = 60): Promise<string[]> {
  const rows = await query<{
    context: string
    target_message: string
    instruction: string
  }>(
    `SELECT context, target_message, instruction
       FROM sim_manual_corrections
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  )
  return rows.map((r) => {
    const quoted = r.target_message.trim()
    const ctx = r.context.trim()
    const parts: string[] = []
    if (ctx) parts.push(`В ситуации:\n${ctx}`)
    if (quoted) parts.push(`Разбираем твоё сообщение: «${quoted}».`)
    parts.push(`Правило: ${r.instruction.trim()}`)
    return parts.join('\n')
  })
}

export async function deleteSimCorrection(id: string): Promise<void> {
  await query(`DELETE FROM sim_manual_corrections WHERE id = $1`, [id])
}

export async function countSimCorrections(): Promise<number> {
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM sim_manual_corrections`,
  )
  return Number(rows[0]?.n ?? 0)
}

/**
 * Full transcript of a simulated dialog for the secret-panel review pane,
 * oldest→newest. Scoped to simulated conversations only, so this can never be
 * used to inspect a real person's chat. Direction 'out' = the simulator's own
 * message (the trainable one); 'in' = the manager/AI replying to it.
 */
export interface SimReviewMessage {
  id: string
  role: 'sim' | 'manager'
  body: string
  createdAt: string
}

export async function getSimDialogForReview(
  conversationId: string,
): Promise<SimReviewMessage[]> {
  const rows = await query<{
    id: string
    direction: 'in' | 'out'
    body: string
    created_at: string | Date
  }>(
    `SELECT m.id, m.direction, m.body, m.created_at
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1
        AND c.is_simulated = true
        AND m.deleted_at IS NULL
      ORDER BY m.created_at ASC
      LIMIT 500`,
    [conversationId],
  )
  return rows.map((r) => ({
    id: r.id,
    // In a simulated thread the fake client (the simulator persona) writes as an
    // INBOUND message ('in') — exactly like a real client — while the manager/AI
    // answers OUTBOUND ('out'). So inbound == sim, outbound == manager.
    role: r.direction === 'in' ? 'sim' : 'manager',
    body: r.body,
    createdAt: new Date(r.created_at).toISOString(),
  }))
}

// Admin corrections change rarely; a short cache keeps them out of the hot
// generation path while still applying edits within a minute.
const SIM_CORRECTIONS_TTL_MS = 60_000
let simCorrectionsCache: { rules: string[]; expires: number } | null = null

/** Invalidate the correction-rules cache after an add/delete from the panel. */
export function invalidateSimCorrectionsCache(): void {
  simCorrectionsCache = null
}

/**
 * Admin "here you're wrong" rules for injection into every simulator prompt.
 * Cached in-process, refreshed lazily. Never throws — a DB hiccup just yields
 * an empty rule set so generation continues.
 */
export async function getSimCorrectionRulesCached(): Promise<string[]> {
  if (simCorrectionsCache && simCorrectionsCache.expires > Date.now()) {
    return simCorrectionsCache.rules
  }
  let rules: string[] = []
  try {
    rules = await listSimCorrectionRules(60)
  } catch {
    rules = []
  }
  simCorrectionsCache = { rules, expires: Date.now() + SIM_CORRECTIONS_TTL_MS }
  return rules
}
