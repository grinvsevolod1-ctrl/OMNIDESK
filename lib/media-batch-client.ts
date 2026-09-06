/**
 * Browser side of bulk photo upload: splits the staged files into chunks and
 * POSTs each to /api/chat-media/batch, reporting progress after every chunk.
 * Shared by the manager and curator inboxes so both get identical behaviour.
 */

import { toast } from 'sonner'
import {
  chunkFiles,
  MAX_FILES_PER_REQUEST,
  type BatchResponse,
} from '@/lib/media-batch'

/** One toast summarising a finished batch (same wording for both roles). */
export function reportBatchOutcome(outcome: BatchOutcome): void {
  const { sent, failed, skipped, message } = outcome
  if (skipped.length) {
    toast.warning(
      skipped.length === 1
        ? `Файл «${skipped[0]}» слишком большой для этого канала — пропущен.`
        : `${skipped.length} файлов слишком большие для этого канала — пропущены.`,
    )
  }
  if (failed === 0 && sent > 0) {
    toast.success(sent === 1 ? 'Файл отправлен.' : `Отправлено ${sent} файлов.`)
    return
  }
  if (sent > 0) {
    toast.error(message ?? `Отправлено ${sent}, не удалось ${failed}.`)
    return
  }
  if (failed > 0) toast.error(message ?? 'Не удалось отправить файлы.')
}

export type BatchChannel = 'telegram' | 'whatsapp' | 'vk'

/** Per-channel single-file caps, mirrored from the server actions. */
const SIZE_CAPS: Record<BatchChannel, number> = {
  telegram: 15 * 1024 * 1024,
  whatsapp: 200 * 1024 * 1024,
  vk: 200 * 1024 * 1024,
}

export interface BatchOutcome {
  sent: number
  failed: number
  /** Files dropped client-side (over the channel cap) before any upload. */
  skipped: string[]
  /** First human-readable failure, if any. */
  message?: string
  /** True when a chunk never reached the server (network / proxy cut). */
  transportError: boolean
}

export async function sendMediaBatch({
  conversationId,
  channel,
  files,
  caption,
  onProgress,
}: {
  conversationId: string
  channel: BatchChannel
  files: File[]
  caption: string
  onProgress: (p: { sent: number; total: number }) => void
}): Promise<BatchOutcome> {
  const cap = SIZE_CAPS[channel]
  const skipped: string[] = []
  const accepted = files.filter((f) => {
    if (f.size > cap) {
      skipped.push(f.name)
      return false
    }
    return true
  })

  const total = accepted.length
  let sent = 0
  let failed = 0
  let message: string | undefined
  onProgress({ sent: 0, total })

  const chunks = chunkFiles(accepted, MAX_FILES_PER_REQUEST)
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci]
    const fd = new FormData()
    fd.append('conversationId', conversationId)
    fd.append('channel', channel)
    // Album semantics: the caption belongs to the very first photo only.
    if (ci === 0 && caption.trim()) fd.append('caption', caption.trim())
    for (const f of chunk) fd.append('file', f, f.name)

    let resp: Response
    try {
      resp = await fetch('/api/chat-media/batch', { method: 'POST', body: fd })
    } catch (err) {
      console.error('media-batch: transport failed:', err)
      failed += total - sent
      return {
        sent,
        failed,
        skipped,
        transportError: true,
        message: 'Сеть прервала загрузку. Проверьте соединение и попробуйте снова.',
      }
    }

    let body: Partial<BatchResponse> = {}
    try {
      body = (await resp.json()) as BatchResponse
    } catch {
      /* non-JSON (cut by a proxy) — handled by status below */
    }

    if (resp.status === 401) {
      failed += total - sent
      return { sent, failed, skipped, transportError: false, message: 'Не авторизовано.' }
    }
    if (resp.status === 413) {
      failed += total - sent
      return {
        sent,
        failed,
        skipped,
        transportError: false,
        message:
          body.message ??
          'Пакет слишком большой для сервера. Уменьшите фото или отправьте меньшими партиями.',
      }
    }
    if (resp.status === 429) {
      failed += total - sent
      return {
        sent,
        failed,
        skipped,
        transportError: false,
        message: body.message ?? 'Слишком много отправок подряд. Подождите немного.',
      }
    }

    const chunkSent = typeof body.sent === 'number' ? body.sent : 0
    const chunkFailed =
      typeof body.failed === 'number' ? body.failed : chunk.length - chunkSent
    sent += chunkSent
    failed += chunkFailed
    if (!message && chunkFailed > 0) {
      message =
        body.results?.find((r) => !r.ok)?.message ??
        body.message ??
        'Часть файлов не отправилась.'
    }
    onProgress({ sent, total })

    // Every file in a chunk failed for a server-side reason (dialog gone,
    // channel misconfigured): stop instead of hammering the same error N times.
    if (chunkSent === 0 && chunk.length > 0 && !resp.ok) {
      failed += total - sent - chunkFailed
      return { sent, failed, skipped, transportError: false, message }
    }
  }

  return { sent, failed, skipped, transportError: false, message }
}
