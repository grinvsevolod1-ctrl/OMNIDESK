'use client'

import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { Field, parseTime, timeValue, type TabProps } from './shared'

const WEEKDAYS: { value: number; label: string }[] = [
  { value: 1, label: 'Пн' },
  { value: 2, label: 'Вт' },
  { value: 3, label: 'Ср' },
  { value: 4, label: 'Чт' },
  { value: 5, label: 'Пт' },
  { value: 6, label: 'Сб' },
  { value: 0, label: 'Вс' },
]

const TIMEZONES = [
  'Europe/Moscow',
  'Europe/Kaliningrad',
  'Europe/Samara',
  'Asia/Yekaterinburg',
  'Asia/Omsk',
  'Asia/Krasnoyarsk',
  'Asia/Irkutsk',
  'Asia/Vladivostok',
  'Europe/Kyiv',
  'Europe/London',
  'UTC',
]

export function HoursTab({ config, patch }: TabProps) {
  const wh = config.workingHours
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div>
          <p className="text-sm font-medium">Учитывать часы работы</p>
          <p className="text-xs text-muted-foreground">
            Вне этих часов показывается экран «нерабочее время» с мессенджерами.
          </p>
        </div>
        <Switch
          checked={wh.enabled}
          onCheckedChange={(v) =>
            patch((d) => void (d.workingHours.enabled = Boolean(v)))
          }
        />
      </div>

      {wh.enabled ? (
        <>
          <Field label="Часовой пояс">
            <Select
              value={wh.tz}
              onValueChange={(v) =>
                patch((d) => void (d.workingHours.tz = v ?? d.workingHours.tz))
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TIMEZONES.map((tz) => (
                  <SelectItem key={tz} value={tz}>
                    {tz}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Начало">
              <Input
                type="time"
                value={timeValue(wh.startHour, wh.startMinute)}
                onChange={(e) => {
                  const { h, m } = parseTime(e.target.value)
                  patch((d) => {
                    d.workingHours.startHour = h
                    d.workingHours.startMinute = m
                  })
                }}
              />
            </Field>
            <Field label="Конец">
              <Input
                type="time"
                value={timeValue(wh.endHour, wh.endMinute)}
                onChange={(e) => {
                  const { h, m } = parseTime(e.target.value)
                  patch((d) => {
                    d.workingHours.endHour = h
                    d.workingHours.endMinute = m
                  })
                }}
              />
            </Field>
          </div>

          <Field
            label="Рабочие дни"
            hint="Если конец раньше начала — окно считается ночным (через полночь)."
          >
            <div className="flex flex-wrap gap-1.5">
              {WEEKDAYS.map((d) => {
                const active = wh.days.includes(d.value)
                return (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() =>
                      patch((draft) => {
                        const set = new Set(draft.workingHours.days)
                        if (set.has(d.value)) {
                          set.delete(d.value)
                        } else {
                          set.add(d.value)
                        }
                        draft.workingHours.days = Array.from(set).sort(
                          (a, b) => a - b,
                        )
                      })
                    }
                    className={cn(
                      'flex size-9 items-center justify-center rounded-md border text-xs font-medium transition-colors',
                      active
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {d.label}
                  </button>
                )
              })}
            </div>
          </Field>

          <div className="rounded-lg border border-border p-3">
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              Экран «нерабочее время»
            </p>
            <div className="flex flex-col gap-3">
              <Field label="Заголовок">
                <Input
                  value={config.offline.title}
                  onChange={(e) =>
                    patch((d) => void (d.offline.title = e.target.value))
                  }
                  placeholder="Мы сейчас не работаем"
                />
              </Field>
              <Field label="Текст">
                <Textarea
                  value={config.offline.text}
                  onChange={(e) =>
                    patch((d) => void (d.offline.text = e.target.value))
                  }
                  rows={3}
                  placeholder="Оставьте сообщение или напишите в мессенджер."
                />
              </Field>
            </div>
          </div>
        </>
      ) : null}
    </div>
  )
}
