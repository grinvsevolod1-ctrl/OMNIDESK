import 'server-only'
import { query } from '../db'
import type { BrainLesson } from '../ai/manager-brain'

/**
 * Training lessons (admin-authored corrections that train the manager brain).
 * Split out of ai-assist.ts (which remains the barrel — import from there).
 */

export interface AiAssistLesson {
  id: string
  situation: string
  draft: string
  corrected: string
  note: string
  createdAt: string
}

interface LessonRow {
  id: string
  situation: string
  draft: string
  corrected: string
  note: string
  created_at: string | Date
}

function mapLesson(r: LessonRow): AiAssistLesson {
  return {
    id: r.id,
    situation: r.situation ?? '',
    draft: r.draft ?? '',
    corrected: r.corrected ?? '',
    note: r.note ?? '',
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/**
 * Most recent lessons for the ADMIN management UI (newest first). Auto-authored
 * lessons (source='auto') are excluded here — and, critically, they are ALSO
 * excluded from `listBrainLessons`, so the real manager's brain is trained only
 * by human-authored lessons.
 */
export async function listLessons(limit = 50): Promise<AiAssistLesson[]> {
  const rows = await query<LessonRow>(
    `SELECT id, situation, draft, corrected, note, created_at
       FROM ai_assist_lessons
      WHERE source IS DISTINCT FROM 'auto'
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(200, limit))],
  )
  return rows.map(mapLesson)
}

/**
 * Lessons in the shape the pure brain expects (for prompt injection). Only
 * human-authored lessons are used — rows tagged source='auto' are excluded so
 * automated scoring can never train the production manager.
 */
export async function listBrainLessons(limit = 12): Promise<BrainLesson[]> {
  const rows = await query<LessonRow>(
    `SELECT situation, corrected, note
       FROM ai_assist_lessons
      WHERE source IS DISTINCT FROM 'auto'
      ORDER BY created_at DESC
      LIMIT $1`,
    [Math.max(1, Math.min(50, limit))],
  )
  return rows.map((r) => ({
    situation: r.situation ?? '',
    corrected: r.corrected ?? '',
    note: r.note ?? '',
  }))
}

/** Persist one training correction. */
export async function addLesson(input: {
  situation: string
  draft: string
  corrected: string
  note: string
}): Promise<AiAssistLesson> {
  const rows = await query<LessonRow>(
    `INSERT INTO ai_assist_lessons (situation, draft, corrected, note)
     VALUES ($1, $2, $3, $4)
     RETURNING id, situation, draft, corrected, note, created_at`,
    [input.situation, input.draft, input.corrected, input.note],
  )
  return mapLesson(rows[0])
}

export async function deleteLesson(id: string): Promise<void> {
  await query(`DELETE FROM ai_assist_lessons WHERE id = $1`, [id])
}

export async function countLessons(): Promise<number> {
  // Match listLessons: count only admin-visible lessons, never auto ones, so
  // the tab badge can't leak internal training volume.
  const rows = await query<{ n: string }>(
    `SELECT count(*)::text AS n
       FROM ai_assist_lessons
      WHERE source IS DISTINCT FROM 'auto'`,
  )
  return Number(rows[0]?.n ?? 0)
}
