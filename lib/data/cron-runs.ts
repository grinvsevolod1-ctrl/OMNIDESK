import 'server-only'

/**
 * Учёт запусков крон-джобов (таблица cron_runs, миграция 133).
 *
 * Зачем: история lead_attachments показала, что крон может месяцами молча
 * падать — единственным следом были строки в PM2-логах, куда никто не
 * смотрит. Теперь каждый cron-роут фиксирует свои запуски в БД, а карточка
 * «Здоровье системы» в настройках админа подсвечивает джобы, которые давно
 * не отрабатывали успешно.
 *
 * Запись — fire-and-forget: сбой INSERT'а логируется и глотается, чтобы
 * учёт никогда не ломал сам джоб (тот же принцип, что writeAudit).
 */
import { query } from '../db'

/** Ожидаемая периодичность джобов (минуты) — для порога «давно не бегал». */
export const CRON_EXPECTED_INTERVAL_MIN: Record<string, number> = {
  followup: 10,
  'retry-dead-letters': 10,
  'sync-ads': 60,
  'curator-status': 30,
  'console-schedules': 5,
  'ai-health': 15,
  retention: 24 * 60,
}

async function recordCronRun(
  job: string,
  startedAtMs: number,
  ok: boolean,
  error: string | null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO cron_runs (job, started_at, duration_ms, ok, error)
       VALUES ($1, to_timestamp($2 / 1000.0), $3, $4, $5)`,
      [
        job,
        startedAtMs,
        Date.now() - startedAtMs,
        ok,
        error ? error.slice(0, 500) : null,
      ],
    )
  } catch (err) {
    console.error(`[cron-runs] failed to record run of "${job}":`, err)
  }
}

/**
 * Обёртка для тела cron-роута: замеряет длительность и пишет строку в
 * cron_runs на обоих исходах, НЕ меняя поведение — ошибка пробрасывается
 * дальше в существующий catch роута.
 */
export async function runInstrumentedCron<T>(
  job: string,
  fn: () => Promise<T>,
): Promise<T> {
  const started = Date.now()
  try {
    const result = await fn()
    void recordCronRun(job, started, true, null)
    return result
  } catch (err) {
    void recordCronRun(
      job,
      started,
      false,
      err instanceof Error ? err.message : String(err),
    )
    throw err
  }
}

export interface CronJobHealth {
  job: string
  /** Последний запуск (любой исход); null — джоб ни разу не отчитался. */
  lastRunAt: string | null
  lastRunOk: boolean | null
  lastDurationMs: number | null
  /** Последний УСПЕШНЫЙ запуск — главный сигнал «джоб живой». */
  lastOkAt: string | null
  /** Подряд идущих неудач с момента последнего успеха. */
  failStreak: number
  lastError: string | null
  /** Ожидаемый интервал запуска (минуты) для порога тревоги. */
  expectedIntervalMin: number
  /** true = не было успешного запуска дольше 3 ожидаемых интервалов. */
  stale: boolean
}

/**
 * Снимок здоровья кронов для админской карточки. Джобы из
 * CRON_EXPECTED_INTERVAL_MIN, которые НИ РАЗУ не отчитались, тоже попадают в
 * список (как stale) — «джоб вообще не настроен в PM2» и есть главный
 * сценарий тихого отказа.
 */
export async function getCronHealth(): Promise<CronJobHealth[]> {
  const rows = await query<{
    job: string
    last_run_at: string
    last_ok: boolean
    last_duration_ms: number | null
    last_ok_at: string | null
    fail_streak: string
    last_error: string | null
  }>(
    `WITH last_runs AS (
       SELECT DISTINCT ON (job)
              job, started_at, ok, duration_ms, error
         FROM cron_runs
        ORDER BY job, started_at DESC
     ),
     last_ok AS (
       SELECT job, MAX(started_at) AS ok_at
         FROM cron_runs
        WHERE ok
        GROUP BY job
     ),
     streaks AS (
       SELECT r.job, COUNT(*) AS fails
         FROM cron_runs r
         LEFT JOIN last_ok o ON o.job = r.job
        WHERE NOT r.ok
          AND (o.ok_at IS NULL OR r.started_at > o.ok_at)
        GROUP BY r.job
     )
     SELECT lr.job,
            lr.started_at AS last_run_at,
            lr.ok AS last_ok,
            lr.duration_ms AS last_duration_ms,
            o.ok_at AS last_ok_at,
            COALESCE(s.fails, 0)::text AS fail_streak,
            lr.error AS last_error
       FROM last_runs lr
       LEFT JOIN last_ok o ON o.job = lr.job
       LEFT JOIN streaks s ON s.job = lr.job`,
  )

  const byJob = new Map(rows.map((r) => [r.job, r]))
  const now = Date.now()
  const jobs = new Set([
    ...Object.keys(CRON_EXPECTED_INTERVAL_MIN),
    ...rows.map((r) => r.job),
  ])

  return [...jobs]
    .sort()
    .map((job) => {
      const r = byJob.get(job)
      const expected = CRON_EXPECTED_INTERVAL_MIN[job] ?? 60
      const lastOkAt = r?.last_ok_at ? new Date(r.last_ok_at) : null
      const staleThresholdMs = expected * 3 * 60_000
      const stale =
        lastOkAt == null || now - lastOkAt.getTime() > staleThresholdMs
      return {
        job,
        lastRunAt: r ? new Date(r.last_run_at).toISOString() : null,
        lastRunOk: r?.last_ok ?? null,
        lastDurationMs: r?.last_duration_ms ?? null,
        lastOkAt: lastOkAt ? lastOkAt.toISOString() : null,
        failStreak: Number(r?.fail_streak ?? 0),
        lastError: r?.last_error ?? null,
        expectedIntervalMin: expected,
        stale,
      }
    })
}
