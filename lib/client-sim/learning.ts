/**
 * Simulator learning & training-data layer, extracted from the client-sim store
 * monolith and re-exported from it for backward compatibility. Covers admin
 * 'here you're wrong' corrections, real-dialogue style sampling, the learning
 * corpus, and the learned-profile / correction-rule in-process caches consumed
 * by the generator. Depends only on the DB layer and shared types.
 */

import { query } from '@/lib/db'
import type { ChannelType } from '@/lib/types'
import type { LearnedProfile } from './types'

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

/* ----------------------- real-dialogue style reference ------------------ */
/*
 * The bot studies how ACTUAL people wrote to managers and mimics that voice.
 * We sample short, genuine inbound lines per channel — explicitly excluding the
 * bot's own threads (sim_threads) so it never learns from itself — and cache
 * them in-process so generation stays cheap.
 */

const REF_TTL_MS = 10 * 60_000
const refCache = new Map<string, { lines: string[]; expires: number }>()

/**
 * Return up to `limit` real client message samples for a channel type, freshly
 * randomised and cached for a few minutes. Filters out media placeholders,
 * links, over-long paragraphs and anything from a simulated thread.
 */
export async function sampleRealClientLines(
  channelType: ChannelType,
  limit = 12,
): Promise<string[]> {
  const key = `${channelType}:${limit}`
  const hit = refCache.get(key)
  if (hit && hit.expires > Date.now()) return hit.lines

  let lines: string[] = []
  try {
    const rows = await query<{ body: string }>(
      `SELECT m.body
         FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'in'
          AND c.channel_type = $1
          AND char_length(m.body) BETWEEN 2 AND 160
          AND m.body !~ '^\\['              -- skip "[фото]" / "[файл]" placeholders
          AND m.body !~* 'https?://'        -- skip links
          AND m.conversation_id NOT IN (SELECT conversation_id FROM sim_threads)
        ORDER BY random()
        LIMIT $2`,
      [channelType, Math.max(1, limit)],
    )
    lines = rows.map((r) => r.body.replace(/\s+/g, ' ').trim()).filter(Boolean)
  } catch (err) {
    console.log(
      '[client-sim] reference sampling failed:',
      err instanceof Error ? err.message : String(err),
    )
  }

  refCache.set(key, { lines, expires: Date.now() + REF_TTL_MS })
  return lines
}

/* --------------------------- learning corpus ---------------------------- */
/*
 * "Изучить все диалоги": read whole real dialogues (client + manager turns) so
 * the analyzer can understand not just isolated phrases but the flow of a real
 * conversation. Bot-driven threads are excluded so it only studies humans.
 */

export interface CorpusDialogue {
  channelType: string
  lines: Array<{ role: 'client' | 'manager'; body: string }>
}

/**
 * Sample up to `maxDialogues` real conversations that have at least a couple of
 * messages, returning their transcripts (trimmed to `maxLinesPerDialogue`).
 */
export async function sampleRealDialogues(
  maxDialogues = 40,
  maxLinesPerDialogue = 12,
): Promise<CorpusDialogue[]> {
  const convs = await query<{ id: string; channel_type: string }>(
    `SELECT c.id, c.channel_type
       FROM conversations c
      WHERE c.id NOT IN (SELECT conversation_id FROM sim_threads)
        AND EXISTS (
          SELECT 1 FROM messages m
           WHERE m.conversation_id = c.id AND m.direction = 'in'
        )
      ORDER BY c.last_message_at DESC NULLS LAST
      LIMIT $1`,
    [Math.max(1, maxDialogues)],
  )
  if (convs.length === 0) return []

  const out: CorpusDialogue[] = []
  for (const c of convs) {
    const msgs = await query<{ direction: 'in' | 'out'; body: string }>(
      `SELECT direction, body
         FROM messages
        WHERE conversation_id = $1
          AND char_length(body) BETWEEN 1 AND 400
          AND body !~ '^\\['
        ORDER BY created_at ASC
        LIMIT $2`,
      [c.id, Math.max(2, maxLinesPerDialogue)],
    )
    const lines = msgs
      .map((m) => ({
        role: (m.direction === 'in' ? 'client' : 'manager') as 'client' | 'manager',
        body: m.body.replace(/\s+/g, ' ').trim(),
      }))
      .filter((l) => l.body)
    if (lines.some((l) => l.role === 'client')) {
      out.push({ channelType: c.channel_type, lines })
    }
  }
  return out
}

/** Persist the latest learned profile onto the singleton settings row. */
export async function saveLearnedProfile(profile: LearnedProfile): Promise<void> {
  await query(
    `UPDATE sim_settings
        SET learned_profile = $1::jsonb, updated_at = now()
      WHERE id = true`,
    [JSON.stringify(profile)],
  )
  // Refresh the generator cache immediately.
  learnedCache = { pointers: buildPointers(profile), expires: Date.now() + LEARN_TTL_MS }
}

/* -------- learned-profile cache consumed by the generator ---------------- */

const LEARN_TTL_MS = 5 * 60_000
let learnedCache: { pointers: string[]; expires: number } | null = null

function buildPointers(p: LearnedProfile | null): string[] {
  if (!p) return []
  // The most directly actionable signals for imitation.
  return [...p.stylePointers, ...p.toneNotes].filter(Boolean).slice(0, 12)
}

/**
 * Style pointers distilled by the last "learn" run, for injection into the
 * generator prompt. Cached in-process and refreshed lazily from the DB.
 */
export async function getLearnedPointersCached(): Promise<string[]> {
  if (learnedCache && learnedCache.expires > Date.now()) return learnedCache.pointers
  let pointers: string[] = []
  try {
    const rows = await query<{ learned_profile: LearnedProfile | null }>(
      `SELECT learned_profile FROM sim_settings WHERE id = true LIMIT 1`,
    )
    pointers = buildPointers(rows[0]?.learned_profile ?? null)
  } catch {
    pointers = []
  }
  learnedCache = { pointers, expires: Date.now() + LEARN_TTL_MS }
  return pointers
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
