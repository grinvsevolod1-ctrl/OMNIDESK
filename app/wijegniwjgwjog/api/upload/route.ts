import { NextResponse } from 'next/server'
import { secretSendMediaMessageAction } from '@/app/actions/admin-secret/conversations'

export const runtime = 'nodejs'
export const maxDuration = 120

/**
 * POST /wijegniwjgwjog/api/upload — файл в диалог god-мессенджера.
 *
 * Живёт под секретным префиксом (не в /api/*), чтобы существование панели
 * нельзя было обнаружить перебором публичных роутов. Fetch-роут вместо
 * вызова server action из клиента: POST экшена с крупным видео режется
 * прокси-слоями до обработчика Next и падает с генерик-ошибкой фреймворка.
 * Гейт и вся логика — внутри существующего экшена (assertConsoleOrMessenger).
 */
export async function POST(req: Request): Promise<NextResponse> {
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json(
      { ok: false, message: 'Некорректное тело запроса.' },
      { status: 400 },
    )
  }
  try {
    const res = await secretSendMediaMessageAction(form)
    return NextResponse.json(res, { status: res.ok ? 200 : 422 })
  } catch (err) {
    // Гейт бросает при отсутствии доступа — отвечаем как обычный 404,
    // неотличимо от несуществующего пути.
    const msg = err instanceof Error ? err.message : ''
    if (/unauthorized|forbidden|redirect|not.?found/i.test(msg)) {
      return new NextResponse(null, { status: 404 })
    }
    console.error('[god-upload] failed:', err)
    return NextResponse.json(
      { ok: false, message: 'Не удалось отправить файл.' },
      { status: 500 },
    )
  }
}
