import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createConsoleSchedule,
  deleteConsoleSchedule,
  listConsoleSchedules,
  setConsoleScheduleEnabled,
} from '@/lib/data/console-shell'
import type { RunState } from './run-state'
import { truncate } from './run-state'

const WEEKDAY_LABEL = [
  '',
  'понедельник',
  'вторник',
  'среда',
  'четверг',
  'пятница',
  'суббота',
  'воскресенье',
]

function describeSchedule(schedule: string, runMinute: number): string {
  const hh = String(Math.floor(runMinute / 60)).padStart(2, '0')
  const mm = String(runMinute % 60).padStart(2, '0')
  if (schedule === 'hourly') return 'каждый час'
  if (schedule === 'daily') return `ежедневно в ${hh}:${mm}`
  const day = Number.parseInt(schedule.split(':')[1] ?? '1', 10)
  return `каждый ${WEEKDAY_LABEL[day] ?? 'понедельник'} в ${hh}:${mm}`
}

/**
 * Scheduler tools: the copilot manages recurring commands («каждый
 * понедельник — отчёт по лидам»). Execution happens in the cron runner
 * (lib/admin-console/schedule-runner.ts) through the same assistant core.
 */
export function scheduleTools(state: RunState, userId: string) {
  return {
    list_schedules: tool({
      description:
        'Показать запланированные команды (расписания): что выполняется автоматически, когда и с каким последним результатом.',
      inputSchema: z.object({}),
      execute: async () => {
        const schedules = await listConsoleSchedules(userId)
        state.views.push({
          kind: 'schedules',
          title: 'Запланированные команды',
          payload: {
            schedules: schedules.map((s) => ({
              ...s,
              human: describeSchedule(s.schedule, s.runMinute),
            })),
          },
        })
        return {
          count: schedules.length,
          schedules: schedules.map((s) => ({
            id: s.id,
            label: s.label,
            when: describeSchedule(s.schedule, s.runMinute),
            enabled: s.enabled,
            lastRunAt: s.lastRunAt,
          })),
        }
      },
    }),

    create_schedule: tool({
      description:
        'Создать регулярную команду. Примеры: «каждый понедельник в 9 присылай отчёт по лидам» → schedule=weekly:1, runMinute=540, prompt="Сформируй отчёт по лидам". prompt — команда, которую копилот выполнит сам.',
      inputSchema: z.object({
        label: z.string().min(2).max(80).describe('Короткое название, например «Отчёт по лидам»'),
        prompt: z
          .string()
          .min(4)
          .max(500)
          .describe('Команда для выполнения, как если бы её ввёл админ'),
        schedule: z
          .enum([
            'hourly',
            'daily',
            'weekly:1',
            'weekly:2',
            'weekly:3',
            'weekly:4',
            'weekly:5',
            'weekly:6',
            'weekly:7',
          ])
          .describe('hourly | daily | weekly:<1-7>, где 1 = понедельник'),
        runMinute: z
          .number()
          .int()
          .min(0)
          .max(1439)
          .default(540)
          .describe('Минуты с полуночи для daily/weekly (540 = 09:00)'),
      }),
      execute: async ({ label, prompt, schedule, runMinute }) => {
        const created = await createConsoleSchedule({
          userId,
          label,
          prompt,
          schedule,
          runMinute,
        })
        state.actions.push({
          kind: 'schedule',
          label: `Запланировано: ${truncate(label, 40)} (${describeSchedule(schedule, runMinute)})`,
        })
        return {
          ok: true,
          id: created.id,
          when: describeSchedule(schedule, runMinute),
          nextRunAt: created.nextRunAt,
        }
      },
    }),

    toggle_schedule: tool({
      description: 'Включить или выключить запланированную команду по её id.',
      inputSchema: z.object({
        id: z.string().min(8),
        enabled: z.boolean(),
      }),
      execute: async ({ id, enabled }) => {
        const ok = await setConsoleScheduleEnabled(userId, id, enabled)
        if (ok)
          state.actions.push({
            kind: 'schedule',
            label: enabled ? 'Расписание включено' : 'Расписание выключено',
          })
        return ok
          ? { ok: true }
          : { ok: false, error: 'Расписание не найдено' }
      },
    }),

    delete_schedule: tool({
      description: 'Удалить запланированную команду по её id.',
      inputSchema: z.object({ id: z.string().min(8) }),
      execute: async ({ id }) => {
        const ok = await deleteConsoleSchedule(userId, id)
        if (ok)
          state.actions.push({ kind: 'schedule', label: 'Расписание удалено' })
        return ok
          ? { ok: true }
          : { ok: false, error: 'Расписание не найдено' }
      },
    }),
  }
}
