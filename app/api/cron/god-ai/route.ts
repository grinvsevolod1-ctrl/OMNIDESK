import { NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron-auth'
import { runInstrumentedCron } from '@/lib/data/cron-runs'
import { runAutopilotTick } from '@/lib/god-autopilot/runtime'
import { logServerError } from '@/lib/server-log'
import { runWithRequestContext } from '@/lib/request-context'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * ИИ-автопилот god-мессенджера («ИИ в чатах»).
 *
 * Один tick: планирует хаотичные слоты на рабочий день МСК, создаёт по
 * доспевшим слотам новые входящие диалоги «от клиентов» и ведёт активные
 * диалоги, отвечая менеджеру как живой клиент. Пока автопилот выключен в
 * настройках мессенджера — полный no-op, поэтому частые запуски безопасны.
 *
 * Self-hosted: гоняется по расписанию pm2/crontab через
 * scripts/cron-god-ai.mjs (app `omnidesk-cron-god-ai` в ecosystem.config.js).
 * Защищён тем же CRON_SECRET bearer-контрактом, что и остальные крон-роуты.
 *
 * ИЗОЛЯЦИЯ (AGENTS.md §4): создаёт ОБЫЧНЫЕ реальные диалоги; никакой пометки
 * is_simulated, никаких записей в admin-видимый журнал аудита.
 */
export async function GET(request: Request): Promise<Response> {
  return runWithRequestContext(request, () => handle(request))
}

async function handle(request: Request): Promise<Response> {
  const denied = requireCronAuth(request)
  if (denied) return denied

  try {
    const result = await runInstrumentedCron('god-ai', () =>
      runAutopilotTick({ maxCreate: 5, maxReplies: 15 }),
    )
    return NextResponse.json({ ok: true, result })
  } catch (error) {
    const errorId = logServerError('cron.god-ai', error)
    return NextResponse.json(
      { ok: false, error: 'server_error', errorId },
      { status: 500 },
    )
  }
}
