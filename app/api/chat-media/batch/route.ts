import { NextResponse } from 'next/server'
import {
  sendTelegramMediaAction,
  sendVkMediaAction,
  sendWhatsappMediaAction,
} from '@/app/actions/account-media'
import {
  sendCuratorVkMediaAction,
  sendCuratorWhatsappMediaAction,
} from '@/app/actions/curator-media'
import { sendCuratorTelegramMediaAction } from '@/app/actions/curator-messages'
import { getSession } from '@/lib/auth'
import {
  MAX_FILES_PER_REQUEST,
  type BatchItemResult,
  type BatchResponse,
} from '@/lib/media-batch'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
// A chunk of up to MAX_FILES_PER_REQUEST photos is archived + enqueued (Telegram)
// or uploaded to the provider (WhatsApp/VK) inside ONE request — give it room.
export const maxDuration = 300

/** Anti-abuse: chunks per user per 10 minutes (≈ 1 200 files). */
const BATCH_LIMIT_PER_WINDOW = 60

type Channel = 'telegram' | 'whatsapp' | 'vk'

/**
 * POST /api/chat-media/batch — send MANY files to one dialog in one request.
 *
 * Bulk photo upload (20 / 50 / 100+ pictures from a phone) used to be N
 * separate round-trips — one server action per file — which is slow on mobile
 * and fragile. This route accepts a chunk of files as FormData and runs the
 * existing per-file send logic server-side, in order, reusing the role-scoped
 * actions untouched (ownership checks, size caps, archive-at-send, job enqueue).
 * Works for managers AND curators — the role decides which action family runs.
 *
 * FormData: conversationId, channel ('telegram'|'whatsapp'|'vk'), caption?,
 *           file (repeated). The caption rides on the FIRST file only — album
 *           semantics, same as the composer's single-file loop.
 */
export async function POST(req: Request): Promise<NextResponse<BatchResponse>> {
  const session = await getSession()
  if (!session || (session.role !== 'manager' && session.role !== 'curator')) {
    return NextResponse.json(fail('Не авторизовано.'), { status: 401 })
  }
  const guard = await rateLimit(
    `chat-batch:${session.sub}`,
    BATCH_LIMIT_PER_WINDOW,
    10 * 60_000,
  )
  if (!guard.allowed) {
    return NextResponse.json(
      fail(
        `Слишком много отправок подряд. Повторите через ${Math.ceil(guard.retryAfterSec / 60)} мин.`,
      ),
      { status: 429 },
    )
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json(fail('Некорректное тело запроса.'), { status: 400 })
  }

  const conversationId = String(form.get('conversationId') || '')
  const channel = String(form.get('channel') || '') as Channel
  if (
    !conversationId ||
    (channel !== 'telegram' && channel !== 'whatsapp' && channel !== 'vk')
  ) {
    return NextResponse.json(fail('Не указан диалог или канал.'), { status: 400 })
  }
  const caption = String(form.get('caption') ?? '').trim()
  const files = form
    .getAll('file')
    .filter((f): f is File => f instanceof File && f.size > 0)
  if (files.length === 0) {
    return NextResponse.json(fail('Файлы не выбраны.'), { status: 400 })
  }
  if (files.length > MAX_FILES_PER_REQUEST) {
    return NextResponse.json(
      fail(`Не больше ${MAX_FILES_PER_REQUEST} файлов за один запрос.`),
      { status: 413 },
    )
  }

  const isCurator = session.role === 'curator'
  const results: BatchItemResult[] = []
  // Sequential on purpose: message order in the thread must match the order
  // the user picked the photos in, and the worker queue is FIFO.
  for (let i = 0; i < files.length; i++) {
    const file = files[i]
    const fileCaption = i === 0 ? caption : ''
    try {
      const res = await sendOne(channel, isCurator, conversationId, file, fileCaption)
      results.push({ name: file.name, ok: res.ok, message: res.message })
    } catch (err) {
      const msg = err instanceof Error ? err.message : ''
      if (/unauthorized|forbidden|redirect/i.test(msg)) {
        return NextResponse.json(fail('Не авторизовано.'), { status: 401 })
      }
      console.error('[api/chat-media/batch] item failed:', file.name, err)
      results.push({
        name: file.name,
        ok: false,
        message: 'Не удалось отправить файл.',
      })
    }
  }

  const sent = results.filter((r) => r.ok).length
  const failed = results.length - sent
  return NextResponse.json(
    {
      ok: failed === 0,
      sent,
      failed,
      results,
      ...(failed > 0
        ? {
            message:
              sent === 0
                ? (results.find((r) => !r.ok)?.message ?? 'Не удалось отправить файлы.')
                : `Отправлено ${sent}, не удалось ${failed}.`,
          }
        : {}),
    },
    // 207-ish semantics via 200 + per-item flags: a partial success is still a
    // success for the transport layer; the client reads `failed`.
    { status: sent > 0 ? 200 : 422 },
  )
}

function fail(message: string): BatchResponse {
  return { ok: false, sent: 0, failed: 0, results: [], message }
}

async function sendOne(
  channel: Channel,
  isCurator: boolean,
  conversationId: string,
  file: File,
  caption: string,
): Promise<{ ok: boolean; message?: string }> {
  if (channel === 'telegram') {
    // The Telegram actions take the bytes base64-encoded (they ride the worker
    // job payload). Encoding here — not in the browser — is the whole point:
    // the phone uploads raw bytes once and never touches base64.
    const base64 = Buffer.from(await file.arrayBuffer()).toString('base64')
    const payload = {
      base64,
      mime: file.type || 'application/octet-stream',
      name: file.name || 'file',
    }
    return isCurator
      ? sendCuratorTelegramMediaAction(conversationId, payload, caption)
      : sendTelegramMediaAction(conversationId, payload, caption)
  }
  // WhatsApp / VK actions consume a single-file FormData — rebuild one per file.
  const fd = new FormData()
  fd.append('file', file)
  if (caption) fd.append('caption', caption)
  if (channel === 'vk') {
    return isCurator
      ? sendCuratorVkMediaAction(conversationId, fd)
      : sendVkMediaAction(conversationId, fd)
  }
  return isCurator
    ? sendCuratorWhatsappMediaAction(conversationId, fd)
    : sendWhatsappMediaAction(conversationId, fd)
}
