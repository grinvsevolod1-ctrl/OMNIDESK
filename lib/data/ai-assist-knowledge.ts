import 'server-only'
import { query } from '../db'
import { embedText, toVectorLiteral } from '../ai/manager-brain'

/**
 * RAG knowledge base (embeddings over ai_knowledge).
 * Split out of ai-assist.ts (which remains the barrel — import from there).
 */

export interface KnowledgeEntry {
  id: string
  title: string
  content: string
  enabled: boolean
  hasEmbedding: boolean
  updatedAt: string
}

interface KnowledgeRow {
  id: string
  title: string
  content: string
  enabled: boolean
  has_embedding: boolean
  updated_at: string | Date
}

function mapKnowledge(r: KnowledgeRow): KnowledgeEntry {
  return {
    id: r.id,
    title: r.title ?? '',
    content: r.content ?? '',
    enabled: !!r.enabled,
    hasEmbedding: !!r.has_embedding,
    updatedAt: new Date(r.updated_at).toISOString(),
  }
}

/** List all knowledge entries (admin management view). */
export async function listKnowledge(): Promise<KnowledgeEntry[]> {
  const rows = await query<KnowledgeRow>(
    `SELECT id, title, content, enabled,
            (embedding IS NOT NULL) AS has_embedding, updated_at
       FROM ai_knowledge
      ORDER BY updated_at DESC`,
  )
  return rows.map(mapKnowledge)
}

/**
 * Create or replace a knowledge entry, computing its embedding up front. When
 * embedding fails the row is still stored (embedding NULL) so no content is
 * lost; it just won't be retrieved until re-embedded.
 */
export async function upsertKnowledge(input: {
  id?: string
  title: string
  content: string
  enabled?: boolean
}): Promise<KnowledgeEntry> {
  const embedding = await embedText(`${input.title}\n\n${input.content}`)
  const vecLiteral = embedding ? toVectorLiteral(embedding) : null

  if (input.id) {
    const rows = await query<KnowledgeRow>(
      `UPDATE ai_knowledge
          SET title = $2, content = $3,
              enabled = COALESCE($4, enabled),
              embedding = COALESCE($5::vector, embedding),
              updated_at = now()
        WHERE id = $1
        RETURNING id, title, content, enabled,
                  (embedding IS NOT NULL) AS has_embedding, updated_at`,
      [input.id, input.title, input.content, input.enabled ?? null, vecLiteral],
    )
    return mapKnowledge(rows[0])
  }

  const rows = await query<KnowledgeRow>(
    `INSERT INTO ai_knowledge (title, content, enabled, embedding)
       VALUES ($1, $2, COALESCE($3, true), $4::vector)
     RETURNING id, title, content, enabled,
               (embedding IS NOT NULL) AS has_embedding, updated_at`,
    [input.title, input.content, input.enabled ?? null, vecLiteral],
  )
  return mapKnowledge(rows[0])
}

/** Delete a knowledge entry. */
export async function deleteKnowledge(id: string): Promise<void> {
  await query(`DELETE FROM ai_knowledge WHERE id = $1`, [id])
}

/**
 * Retrieve the top-K knowledge chunks most relevant to `queryText`, assembled
 * into a compact block for injection into ManagerBrainInput.knowledge. Returns
 * '' when RAG is unavailable (no embedding, no matches, or pre-migration) so
 * the caller simply proceeds without retrieved facts. Best-effort — never
 * throws into the reply path.
 */
export async function retrieveKnowledge(
  queryText: string,
  topK = 4,
): Promise<string> {
  try {
    const embedding = await embedText(queryText)
    if (!embedding) return ''
    const rows = await query<{ title: string; content: string; dist: number }>(
      `SELECT title, content, (embedding <=> $1::vector) AS dist
         FROM ai_knowledge
        WHERE enabled = true AND embedding IS NOT NULL
        ORDER BY embedding <=> $1::vector
        LIMIT $2`,
      [toVectorLiteral(embedding), Math.max(1, Math.min(10, topK))],
    )
    // Cosine distance < ~0.55 keeps only genuinely relevant chunks and avoids
    // stuffing the prompt with unrelated entries.
    const relevant = rows.filter((r) => Number(r.dist) < 0.55)
    if (relevant.length === 0) return ''
    return relevant
      .map((r) => (r.title ? `• ${r.title}: ${r.content}` : `• ${r.content}`))
      .join('\n')
  } catch {
    return ''
  }
}
