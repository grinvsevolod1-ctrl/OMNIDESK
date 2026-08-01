/**
 * Embeddings for the shared RAG knowledge base — one code path for both
 * runtimes. Same dependency rules as the rest of lib/ai/brain/ (see core.ts).
 */

const EMBEDDING_URL = 'https://ai-gateway.vercel.sh/v1/embeddings'
// Must match the vector(N) dimension in migration 071 (1536 for this model).
export const EMBEDDING_MODEL =
  process.env.MANAGER_AI_EMBEDDING_MODEL || 'openai/text-embedding-3-small'
export const EMBEDDING_DIM = 1536

/**
 * Embed a single text into a vector via the AI Gateway. Dependency-free (raw
 * fetch, same as the rest of this module) so both the panel and the worker can
 * build embeddings through one code path. Returns null on any failure so
 * callers degrade gracefully (skip RAG rather than break the reply).
 */
export async function embedText(text: string): Promise<number[] | null> {
  const key = process.env.AI_GATEWAY_API_KEY
  const input = text.trim()
  if (!key || !input) return null
  try {
    const res = await fetch(EMBEDDING_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
    })
    if (!res.ok) {
      console.warn('[manager-brain] embedding HTTP', res.status)
      return null
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>
    }
    const vec = data.data?.[0]?.embedding
    return Array.isArray(vec) && vec.length > 0 ? vec : null
  } catch (err) {
    console.warn(
      '[manager-brain] embedding failed:',
      err instanceof Error ? err.message : String(err),
    )
    return null
  }
}

/** Serialize a JS number[] into the pgvector text literal '[a,b,c]'. */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}
