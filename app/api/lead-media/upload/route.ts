import { NextResponse } from 'next/server'
import { getSession } from '@/lib/auth'
import { getLeadCardById } from '@/lib/data/lead-cards'
import {
  addLeadFileAttachment,
  listLeadAttachments,
} from '@/lib/data/lead-attachments'
import { countLeadsNeedingStatus } from '@/lib/data/lead-discipline'
import { isPastDailyDeadline } from '@/lib/lead-status'
import { mskDayKey } from '@/lib/time'
import { rateLimit } from '@/lib/rate-limit'

export const runtime = 'nodejs'
// Загрузка всегда идёт с формой пользователя — кэшировать нечего.
export const dynamic = 'force-dynamic'

/** Лимиты вложений карточки: до 10 файлов за раз, до 50 МБ каждый. */
const MAX_COUNT = 10
const MAX_BYTES = 50 * 1024 * 1024

function json(status: number, body: { ok: boolean; message: string; attachments?: unknown }) {
  return NextResponse.json(body, { status })
}

/**
 * POST /api/lead-media/upload — загрузка фото/видео в карточку лида.
 *
 * Почему роут, а не server action: POST серверного экшена с крупным телом
 * (видео) режется прокси-слоями (nginx / preview-proxy) ДО обработчика, и
 * клиент получает генерик «An unexpected response was received from the
 * server». Обычный fetch к роуту возвращает честный JSON с понятной ошибкой
 * и не зависит от лимитов сериализации server actions.
 */
export async function POST(req: Request) {
  const session = await getSession()
  if (!session) return json(401, { ok: false, message: 'Не авторизовано.' })

  // Анти-абьюз: даже валидный аккаунт не может заливать 50-МБ файлы в цикле
  // и забивать диск. 30 запросов (до 300 файлов) за 10 минут — за глаза.
  const guard = await rateLimit(`lead-upload:${session.sub}`, 30, 10 * 60_000)
  if (!guard.allowed) {
    return json(429, {
      ok: false,
      message: `Слишком много загрузок подряд. Повторите через ${Math.ceil(guard.retryAfterSec / 60)} мин.`,
    })
  }

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return json(413, {
      ok: false,
      message:
        'Не удалось принять файлы: запрос слишком большой. Уменьшите видео или загрузите файлы по одному.',
    })
  }

  const leadCardId = String(form.get('leadCardId') || '')
  if (!leadCardId) return json(400, { ok: false, message: 'Нет карточки.' })

  const card = await getLeadCardById(leadCardId)
  const canAccess =
    card &&
    (session.role === 'admin' ||
      (session.role === 'curator' && card.curatorId === session.sub) ||
      (session.role === 'manager' && card.managerId === session.sub))
  if (!canAccess) return json(404, { ok: false, message: 'Лид не найден.' })

  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) return json(400, { ok: false, message: 'Нет файлов.' })
  if (files.length > MAX_COUNT) {
    return json(400, {
      ok: false,
      message: `За раз можно до ${MAX_COUNT} файлов.`,
    })
  }

  // Дисциплина менеджера по кадрам: после дедлайна с неподтверждёнными статусами
  // рабочее место ограничено — как и в server actions.
  if (session.role === 'curator' && isPastDailyDeadline()) {
    const pending = await countLeadsNeedingStatus(
      session.sub,
      mskDayKey(new Date()),
      true,
    )
    if (pending > 0) {
      return json(423, {
        ok: false,
        message: `Рабочее место ограничено: подтвердите статусы всех лидов (осталось ${pending}).`,
      })
    }
  }

  try {
    for (const file of files) {
      if (file.size === 0) continue
      if (file.size > MAX_BYTES) {
        return json(413, {
          ok: false,
          message: `Файл «${file.name}» больше ${Math.round(MAX_BYTES / (1024 * 1024))} МБ.`,
        })
      }
      const mime = file.type || 'application/octet-stream'
      const isImage = mime.startsWith('image/')
      const isVideo = mime.startsWith('video/')
      if (!isImage && !isVideo) {
        return json(415, {
          ok: false,
          message: `«${file.name}»: только фото или видео.`,
        })
      }
      const bytes = Buffer.from(await file.arrayBuffer())
      await addLeadFileAttachment({
        leadCardId,
        authorId: session.sub,
        kind: isImage ? 'photo' : 'video',
        bytes,
        mime,
        fileName: file.name || null,
      })
    }

    const list = await listLeadAttachments(leadCardId)
    const attachments = list.map((a) => ({
      ...a,
      canDelete: session.role === 'admin' || a.authorId === session.sub,
    }))
    return json(200, { ok: true, message: 'Файлы прикреплены.', attachments })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка загрузки'
    return json(500, { ok: false, message: msg })
  }
}
