import { NextResponse } from 'next/server'
import { requireCronAuth } from '@/lib/cron-auth'
import { query } from '@/lib/db'
import { logAi } from '@/lib/data/ai-log'
import { runInstrumentedCron } from '@/lib/data/cron-runs'
import { runWithRequestContext } from '@/lib/request-context'
import { logServerError } from '@/lib/server-log'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

/**
 * AI-manager health watchdog.
 *
 * The seller talks to REAL customers: when the brain starts failing
 * systematically (gateway out of credits, revoked key, model outage, prompt
 * overgrowing the context window), every silent hour is lost deals — and
 * until now the only way to notice was a customer complaining. This sweep
 * computes the error rate of AI reply attempts over the last hour from
 * `ai_logs` and, past a threshold, notifies the owner.
 *
 * Delivery is two-tier:
 *  1. ALWAYS a marker row in ai_logs (source 'health', event 'health.alert')
 *     — surfaces in the admin "Логи" tab with error colouring.
 *  2. OPTIONALLY a Telegram message when TELEGRAM_ALERT_BOT_TOKEN and
 *     TELEGRAM_ALERT_CHAT_ID are configured (a plain bot the owner creates
 *     via @BotFather; unrelated to the seller's MTProto accounts).
 *
 * Anti-noise guards: alerts need a minimum sample (low volume with one error
 * is not an incident), and re-alerts are suppressed while a recent health
 * marker exists — the sweep can run every 10 minutes safely.
 *
 * Self-hosted: driven by pm2 via `scripts/cron-ai-health.mjs`
 * (app `omnidesk-cron-ai-health` in ecosystem.config.js).
 */

/** Sliding window the error rate is computed over. */
const WINDOW_MINUTES = 60
/** Don't alert below this many reply attempts in the window (sample size). */
const MIN_ATTEMPTS = 5
/** Alert when errors / attempts reaches this share. */
const ERROR_RATE_THRESHOLD = 0.3
/** Suppress repeat alerts while a health marker newer than this exists. */
const REALERT_COOLDOWN_MINUTES = 360

export async function GET(request: Request): Promise<Response> {
  return runWithRequestContext(request, () => handle(request))
}

async function handle(request: Request): Promise<Response> {
  const denied = requireCronAuth(request)
  if (denied) return denied

  try {
    const payload = await runInstrumentedCron('ai-health', () => watch())
    return NextResponse.json({ ok: true, ...payload })
  } catch (err) {
    logServerError('cron/ai-health failed', { err })
    return NextResponse.json({ ok: false, error: 'internal' }, { status: 500 })
  }
}

/** Тело вотчдога, вынесенное из handle: единый возврат payload'а для учёта. */
async function watch(): Promise<Record<string, unknown>> {
  {
    // One pass over the cooldown horizon: reply attempts = successful sends +
    // hard errors, both restricted to the sliding window; the alert-marker
    // count uses the longer cooldown horizon. Skips (master off, not led,
    // rate cap) are intentional silence, not failures — counting them would
    // dilute the rate and hide incidents.
    const [stats] = await query<{
      errors: number
      replies: number
      recent_alerts: number
    }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE level = 'error' AND source <> 'health'
             AND created_at > now() - make_interval(mins => $1)
         )::int AS errors,
         COUNT(*) FILTER (
           WHERE event = 'reply.sent'
             AND created_at > now() - make_interval(mins => $1)
         )::int AS replies,
         COUNT(*) FILTER (
           WHERE source = 'health' AND event = 'health.alert'
         )::int AS recent_alerts
       FROM ai_logs
       WHERE created_at > now() - make_interval(mins => $2)`,
      [WINDOW_MINUTES, REALERT_COOLDOWN_MINUTES],
    )

    const errors = stats?.errors ?? 0
    const replies = stats?.replies ?? 0
    const attempts = errors + replies
    const rate = attempts > 0 ? errors / attempts : 0
    const breached = attempts >= MIN_ATTEMPTS && rate >= ERROR_RATE_THRESHOLD
    const suppressed = (stats?.recent_alerts ?? 0) > 0

    if (!breached) {
      return { alerted: false, attempts, errors, rate }
    }
    if (suppressed) {
      return { alerted: false, suppressed: true, attempts, errors, rate }
    }

    const pct = Math.round(rate * 100)
    const text =
      `Проблема с ИИ-продавцом: ${pct}% ошибок за последний час ` +
      `(${errors} из ${attempts} попыток ответа). ` +
      `Проверьте вкладку «Логи» в админке — возможные причины: закончились ` +
      `кредиты шлюза, отозван ключ, недоступна модель.`

    // Tier 1: the marker row — visible in the "Логи" tab, and the row the
    // cooldown check above keys off.
    void logAi({
      level: 'error',
      source: 'health',
      event: 'health.alert',
      message: text,
      meta: { errors, replies, attempts, rate },
    })

    // Tier 2: optional Telegram bot message to the owner.
    const token = (process.env.TELEGRAM_ALERT_BOT_TOKEN ?? '').trim()
    const chatId = (process.env.TELEGRAM_ALERT_CHAT_ID ?? '').trim()
    let telegram: 'sent' | 'failed' | 'not_configured' = 'not_configured'
    if (token && chatId) {
      try {
        const res = await fetch(
          `https://api.telegram.org/bot${token}/sendMessage`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text }),
            signal: AbortSignal.timeout(10_000),
          },
        )
        telegram = res.ok ? 'sent' : 'failed'
        if (!res.ok) {
          logServerError('cron/ai-health telegram send failed', {
            status: res.status,
          })
        }
      } catch (err) {
        telegram = 'failed'
        logServerError('cron/ai-health telegram send threw', { err })
      }
    }

    return { alerted: true, attempts, errors, rate, telegram }
  }
}
