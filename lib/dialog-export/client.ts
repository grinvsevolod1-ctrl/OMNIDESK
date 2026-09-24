/**
 * Браузерная часть выгрузки диалога: снимок с сервера → (опционально) докачка
 * медиа через `/api/media/{id}` → HTML → скачивание.
 *
 * Медиа качается ТЕМ ЖЕ путём, что и плитки в ленте (owner-гейт по роли,
 * лестница «архив → payload джоба → воркер»), поэтому серверу не нужен второй
 * медиа-пайплайн. Упаковка — клиентский fflate (уже используется для ZIP фото
 * из ленты, см. lib/media-download-client). Один диалог = один файл:
 *   - с медиа  → `dialog-<контакт>-<дата>.zip` (dialog.html + media/*),
 *   - без медиа → `dialog-<контакт>-<дата>.html` (самодостаточный).
 */

import type { Message } from '@/lib/types'
import { bulkFilenames } from '@/lib/media-download'
import { downloadBlob, packZip, prepareFiles } from '@/lib/media-download-client'
import { renderDialogHtml } from './render-html'
import { dialogExportFilename, HTML_ENTRY, MEDIA_DIR } from './naming'
import type { DialogExportPayload, DialogExportResult } from './types'

export type ExportPhase =
  | { step: 'loading' }
  | { step: 'media'; done: number; total: number }
  | { step: 'packing' }

export interface DialogExportOutcome {
  filename: string
  messages: number
  /** Сколько вложений реально попало в архив / сколько было в переписке. */
  mediaAttached: number
  mediaTotal: number
  truncated: boolean
}

/** Сообщения, у которых есть что скачивать (URL медиа отдаёт сервер). */
export function mediaMessagesOf(messages: Message[]): Message[] {
  return messages.filter((m) => Boolean(m.mediaType && m.mediaUrl))
}

export async function runDialogExport({
  fetchPayload,
  includeMedia,
  onPhase,
  signal,
}: {
  /** Role-scoped server action (exportDialogAction), уже связанный с диалогом. */
  fetchPayload: () => Promise<DialogExportResult>
  includeMedia: boolean
  onPhase: (phase: ExportPhase) => void
  signal?: AbortSignal
}): Promise<DialogExportOutcome> {
  onPhase({ step: 'loading' })
  const res = await fetchPayload()
  if (!res.ok) throw new Error(res.message)
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  const payload = res.data
  const mediaMessages = mediaMessagesOf(payload.messages)

  if (!includeMedia || mediaMessages.length === 0) {
    onPhase({ step: 'packing' })
    const html = renderDialogHtml(payload, {
      mediaPath: () => null,
      mediaOmitted: true,
    })
    const filename = dialogExportFilename(payload.conversation.contactName, 'html')
    downloadBlob(new Blob([html], { type: 'text/html;charset=utf-8' }), filename)
    return {
      filename,
      messages: payload.messages.length,
      mediaAttached: 0,
      mediaTotal: mediaMessages.length,
      truncated: payload.truncated,
    }
  }

  const { files } = await prepareFiles(
    mediaMessages,
    (done, total) => onPhase({ step: 'media', done, total }),
    signal,
  )
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')

  onPhase({ step: 'packing' })
  // Имена в порядке треда (001-, 002-…) — как у ZIP фото из ленты; в архиве
  // они лежат в подпапке, а HTML ссылается на них относительными путями.
  const names = bulkFilenames(mediaMessages)
  const nameById = new Map<string, string>()
  mediaMessages.forEach((m, i) => nameById.set(m.id, names[i]))
  const pathById = new Map<string, string>()
  const zipFiles: File[] = []
  for (const f of files) {
    const name = nameById.get(f.message.id)
    if (!name) continue
    const path = `${MEDIA_DIR}/${name}`
    pathById.set(f.message.id, path)
    zipFiles.push(
      new File([f.file], path, { type: f.file.type, lastModified: f.file.lastModified }),
    )
  }

  const html = renderDialogHtml(payload, {
    mediaPath: (m) => pathById.get(m.id) ?? null,
    mediaOmitted: false,
  })
  zipFiles.unshift(
    new File([html], HTML_ENTRY, {
      type: 'text/html;charset=utf-8',
      lastModified: Date.now(),
    }),
  )
  const zip = await packZip(zipFiles)
  const filename = dialogExportFilename(payload.conversation.contactName, 'zip')
  downloadBlob(zip, filename)
  return {
    filename,
    messages: payload.messages.length,
    mediaAttached: pathById.size,
    mediaTotal: mediaMessages.length,
    truncated: payload.truncated,
  }
}

export type { DialogExportPayload }
