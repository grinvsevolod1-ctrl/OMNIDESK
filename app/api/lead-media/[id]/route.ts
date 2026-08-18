import { getSession } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  getLeadAttachmentById,
  getLeadAttachmentBytes,
} from '@/lib/data/lead-attachments'
import { getStoredMediaBytes } from '@/lib/data/media-archive'
import { isWorkerConfigured, streamFromWorker } from '@/lib/worker-client'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * Стриминг вложений карточки лида.
 *
 * Доступ: админ, менеджер по кадрам карточки, менеджер карточки — вложения «видны всем»,
 * кто работает с этим лидом, независимо от того, кто владеет исходным диалогом
 * (менеджер по кадрам НЕ владеет диалогом, поэтому /api/media ему недоступен — этот роут
 * закрывает эту дыру собственной проверкой по карточке).
 *
 * Источники байтов:
 *  1) загруженный файл — media_blobs (диск VPS или bytea);
 *  2) кружок — архив исходного сообщения (media_blobs через messages);
 *  3) кружок без архива — живой стрим через воркер (как /api/media).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const session = await getSession()
  if (!session) return new Response('Unauthorized', { status: 401 })

  const { id } = await params
  if (!id) return new Response('Bad request', { status: 400 })

  const attachment = await getLeadAttachmentById(id)
  if (!attachment) return new Response('Not found', { status: 404 })

  // Авторизация по карточке, а не по диалогу.
  const card = await query<{ curator_id: string | null; manager_id: string | null }>(
    `SELECT curator_id, manager_id FROM lead_cards WHERE id = $1`,
    [attachment.leadCardId],
  )
  if (!card[0]) return new Response('Not found', { status: 404 })
  let allowed =
    session.role === 'admin' ||
    (session.role === 'curator' && card[0].curator_id === session.sub) ||
    (session.role === 'manager' && card[0].manager_id === session.sub)
  // Руководитель видит вложения карточек своей группы: куратор ИЛИ менеджер
  // карточки — его подчинённый (та же логика, что canAccessLeadCardAsync).
  if (!allowed && session.role === 'head') {
    const { isCuratorOfHead, isManagerOfHead } = await import('@/lib/data/heads')
    allowed =
      (await isCuratorOfHead(session.sub, card[0].curator_id)) ||
      (await isManagerOfHead(session.sub, card[0].manager_id))
  }
  if (!allowed) return new Response('Forbidden', { status: 403 })

  // 1) Загруженный файл.
  const own = await getLeadAttachmentBytes(id)
  if (own) return bytesResponse(own.bytes, own.mime)

  // 2) Кружок: архивные байты исходного сообщения.
  if (attachment.messageId) {
    const stored = await getStoredMediaBytes(attachment.messageId)
    if (stored) return bytesResponse(stored.bytes, stored.mime)

    // 3) Живой стрим через воркер (Telegram).
    if (isWorkerConfigured) {
      const upstream = await streamFromWorker(
        `/media?messageId=${encodeURIComponent(attachment.messageId)}`,
      )
      if (upstream?.ok && upstream.body) {
        const headers = new Headers()
        for (const h of ['content-type', 'content-length']) {
          const v = upstream.headers.get(h)
          if (v) headers.set(h, v)
        }
        headers.set('cache-control', 'private, max-age=86400')
        return new Response(upstream.body, { status: 200, headers })
      }
    }
  }

  return new Response('Media unavailable', { status: 410 })
}

function bytesResponse(bytes: Buffer, mime: string | null): Response {
  const headers = new Headers()
  headers.set('content-type', mime || 'application/octet-stream')
  headers.set('content-length', String(bytes.byteLength))
  // Вложения неизменяемы после создания.
  headers.set('cache-control', 'private, max-age=31536000, immutable')
  return new Response(new Uint8Array(bytes), { status: 200, headers })
}
