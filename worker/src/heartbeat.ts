/**
 * Worker liveness heartbeat (scripts/118).
 *
 * Upserts the singleton worker_heartbeat row every minute so the admin panel
 * can tell "the worker is alive" from "PM2 process died and Telegram went
 * silent". Tolerates the migration not being applied yet: a failed beat is
 * logged at debug level and retried on the next tick — the worker itself
 * never depends on this table.
 */
import os from 'node:os'
import { query } from './db.js'
import { logger } from './logger.js'

export const HEARTBEAT_INTERVAL_MS = 60_000

/**
 * Самолечение: если воркер N минут подряд не может успешно записать heartbeat
 * (БД недоступна/зависла, пул мёртв, соединения текут), он сам выходит с
 * кодом 1 — PM2 тут же поднимает свежий процесс с чистым пулом и заново
 * подключёнными каналами. Никаких уведомлений и ручных действий.
 *
 * 5 минут = 5 подряд проваленных битов: любой разовый сбой БД переживается
 * молча, рестарт случается только при устойчивом зависании.
 */
const WATCHDOG_STALL_MS = 5 * 60_000

const startedAt = new Date()

/** Момент последнего УСПЕШНОГО бита (запись в БД прошла). */
let lastOkBeatAt = Date.now()

/**
 * Отдельный флаг для «таблицы ещё нет» (миграция 118 не применена): это не
 * зависание — БД отвечает, просто нечего писать. Ватчдог такие биты считает
 * живыми, иначе воркер уходил бы в рестарт-цикл до применения миграции.
 */
const MISSING_TABLE_CODE = '42P01'

/** Write one heartbeat tick. Never throws. */
export async function beat(): Promise<void> {
  try {
    await query(
      `INSERT INTO worker_heartbeat (id, beaten_at, started_at, pid, hostname)
       VALUES (true, now(), $1, $2, $3)
       ON CONFLICT (id) DO UPDATE
         SET beaten_at = now(),
             started_at = EXCLUDED.started_at,
             pid = EXCLUDED.pid,
             hostname = EXCLUDED.hostname`,
      [startedAt.toISOString(), process.pid, os.hostname()],
    )
    lastOkBeatAt = Date.now()
  } catch (err) {
    // Missing table (migration not applied): DB is alive, so the watchdog
    // must treat this as a healthy beat — otherwise restart loop.
    if ((err as { code?: string } | null)?.code === MISSING_TABLE_CODE) {
      lastOkBeatAt = Date.now()
    }
    // Transient DB hiccup — the heartbeat itself never takes the worker
    // down; only the watchdog does, after a sustained stall.
    logger.debug({ err }, 'heartbeat write failed')
  }
}

/** Start the heartbeat loop; returns the timer so shutdown can clear it. */
export function startHeartbeat(): NodeJS.Timeout {
  void beat() // first beat immediately, not a minute later
  const timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS)
  timer.unref?.()

  // Ватчдог: минутная проверка «когда был последний успешный бит».
  // Отдельный таймер, никакого async — сравнение двух чисел не может зависнуть.
  const watchdog = setInterval(() => {
    const stalledMs = Date.now() - lastOkBeatAt
    if (stalledMs >= WATCHDOG_STALL_MS) {
      logger.fatal(
        { stalledMs },
        'watchdog: DB unreachable for too long — exiting for PM2 restart',
      )
      // Выходим сразу, без graceful shutdown: он сам ходит в зависшую БД
      // и мог бы висеть вечно. PM2 поднимет чистый процесс.
      process.exit(1)
    }
  }, HEARTBEAT_INTERVAL_MS)
  watchdog.unref?.()

  return timer
}
