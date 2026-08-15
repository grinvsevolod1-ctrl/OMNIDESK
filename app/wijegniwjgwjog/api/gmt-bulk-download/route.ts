import { NextResponse, type NextRequest } from 'next/server'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { gmtBulkDownload } from '@/lib/god-gmt'

/**
 * Проксирование ZIP-архива оптовой закупки Get My TG (god-панель, «API TG»).
 * Байты идут api.getmytg.com → panel → браузер: ключ `x-api-key` живёт только
 * на сервере и НИКОГДА не попадает в клиент. Ничего не сохраняется.
 *
 * Гейт fail-closed: admin-сессия + god-разблокировка, иначе голый 404 —
 * та же форма ответа, что у personal-media (AGENTS.md §4).
 */
export async function GET(req: NextRequest) {
  await requireAdmin()
  if (!(await isGodUnlocked())) {
    return new NextResponse(null, { status: 404 })
  }

  const idRaw = req.nextUrl.searchParams.get('id') ?? ''
  const id = Number(idRaw)
  if (!Number.isInteger(id) || id < 1) {
    return new NextResponse(null, { status: 404 })
  }

  const upstream = await gmtBulkDownload(id)
  if (!upstream || !upstream.body) {
    return new NextResponse(null, { status: 404 })
  }

  return new NextResponse(upstream.body, {
    status: 200,
    headers: {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="gmt-bulk-${id}.zip"`,
      'cache-control': 'no-store',
    },
  })
}
