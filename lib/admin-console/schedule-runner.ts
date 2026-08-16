import 'server-only'
import {
  claimDueConsoleSchedules,
  recordConsoleScheduleRun,
} from '@/lib/data/console-shell'
import { logServerError } from '@/lib/server-log'
import { runAssistantOnce } from './run-assistant'

/**
 * Executes due scheduled commands («каждый понедельник — отчёт по лидам»)
 * through the SAME assistant core the interactive shell uses, so a schedule
 * can do anything the copilot can. Results land in last_result; the admin
 * reads them via «покажи расписания».
 *
 * Guarded actions stay guarded: a scheduled run can produce a `pending`
 * confirmation but nobody is there to click it — so it simply doesn't apply.
 * Scheduled prompts should be read-only (reports, digests, checks).
 */

export interface ScheduleSweepResult {
  claimed: number
  succeeded: number
  failed: number
}

export async function runDueSchedules(
  limit: number,
): Promise<ScheduleSweepResult> {
  const due = await claimDueConsoleSchedules(limit)
  let succeeded = 0
  let failed = 0

  for (const s of due) {
    try {
      const result = await runAssistantOnce(
        [{ role: 'user', content: s.prompt }],
        s.userId,
      )
      const summary =
        result.source === 'fallback'
          ? `[ИИ недоступен] ${result.reply}`
          : result.reply
      await recordConsoleScheduleRun(s.id, summary, s.schedule, s.runMinute)
      succeeded += 1
    } catch (error) {
      logServerError('console.schedule', error)
      try {
        await recordConsoleScheduleRun(
          s.id,
          'Ошибка выполнения',
          s.schedule,
          s.runMinute,
        )
      } catch {
        // next_run_at was already bumped by the claim; the schedule survives.
      }
      failed += 1
    }
  }

  return { claimed: due.length, succeeded, failed }
}
