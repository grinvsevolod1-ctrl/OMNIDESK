/**
 * Shared contract of POST /api/chat-media/batch (bulk photo upload) — imported
 * by the route AND the client hooks. Lives outside the route file because
 * Next.js only allows handler/config exports there.
 */

/**
 * Files per request. The client splits a big selection (50–100+ photos) into
 * chunks of this size so a single request stays well under proxy body limits
 * and a mid-way network drop loses at most one chunk, not the whole batch.
 */
export const MAX_FILES_PER_REQUEST = 20

/** Upper bound the composer tray accepts in one go. */
export const MAX_BATCH_FILES = 300

export interface BatchItemResult {
  name: string
  ok: boolean
  message?: string
}

export interface BatchResponse {
  ok: boolean
  sent: number
  failed: number
  results: BatchItemResult[]
  message?: string
}

/** Split `files` into consecutive chunks of at most `size` (order preserved). */
export function chunkFiles<T>(files: readonly T[], size = MAX_FILES_PER_REQUEST): T[][] {
  if (size <= 0) throw new Error('chunk size must be positive')
  const out: T[][] = []
  for (let i = 0; i < files.length; i += size) out.push(files.slice(i, i + size))
  return out
}
