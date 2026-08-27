'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { Loader2, Play, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import {
  secretGetAutopilotConfigAction,
  secretSaveAutopilotConfigAction,
  secretRunAutopilotNowAction,
} from '@/app/actions/admin-secret'
import type { AutopilotConfig } from '@/lib/god-autopilot/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { TYPE_LABEL } from './utils'
import type { Channel } from '@/lib/types'

/** "HH:MM" ⇄ минуты от полуночи. */
function minToHHMM(min: number): string {
  const h = Math.floor(min / 60)
  const m = min % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}
function hhmmToMin(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const mm = Number(m[2])
  if (h > 23 || mm > 59) return null
  return h * 60 + mm
}

/**
 * Диалог настройки ИИ-автопилота god-мессенджера («ИИ в чатах»).
 *
 * Владелец описывает тематику словами, выбирает каналы, задаёт рабочее окно
 * МСК, интенсивность и глубину диалога. Всё сохраняется в god_ai_config; фон
 * (крон) сам создаёт диалоги в хаотичное время и ведёт их. При открытии
 * подтягивает актуальную конфигурацию.
 */
export function AiAutopilotDialog({
  open,
  onOpenChange,
  channels,
  onConfigChange,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  channels: Channel[]
  /** Прокинуть наружу актуальный enabled, чтобы кнопка в шапке светилась. */
  onConfigChange?: (config: AutopilotConfig) => void
}) {
  const ownedChannels = useMemo(
    () => channels.filter((c) => c.managerId),
    [channels],
  )

  const [loading, setLoading] = useState(true)
  const [saving, startSave] = useTransition()
  const [running, startRun] = useTransition()

  // Черновик формы.
  const [enabled, setEnabled] = useState(false)
  const [replyEnabled, setReplyEnabled] = useState(true)
  const [topic, setTopic] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [startStr, setStartStr] = useState('10:00')
  const [endStr, setEndStr] = useState('22:00')
  const [dailyTarget, setDailyTarget] = useState('5')
  const [maxTurns, setMaxTurns] = useState('8')

  // Подтянуть конфиг при открытии.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void secretGetAutopilotConfigAction().then((res) => {
      if (cancelled) return
      if (res.ok && res.config) {
        const c = res.config
        setEnabled(c.enabled)
        setReplyEnabled(c.replyEnabled)
        setTopic(c.topic)
        setSelected(new Set(c.channelIds))
        setStartStr(minToHHMM(c.workStartMin))
        setEndStr(minToHHMM(c.workEndMin))
        setDailyTarget(String(c.dailyTarget))
        setMaxTurns(String(c.maxTurns))
      } else if (!res.ok) {
        toast.error(res.message ?? 'Не удалось загрузить настройки')
      }
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [open])

  const toggleChannel = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** Собрать патч из черновика с валидацией времени. */
  function buildPatch(nextEnabled: boolean) {
    const start = hhmmToMin(startStr)
    const end = hhmmToMin(endStr)
    if (start === null || end === null) {
      toast.error('Время в формате ЧЧ:ММ, например 10:00')
      return null
    }
    if (end <= start) {
      toast.error('Конец рабочего окна должен быть позже начала')
      return null
    }
    return {
      enabled: nextEnabled,
      replyEnabled,
      topic: topic.trim(),
      channelIds: Array.from(selected),
      workStartMin: start,
      workEndMin: end,
      dailyTarget: Number(dailyTarget) || 0,
      maxTurns: Number(maxTurns) || 1,
    }
  }

  function save(nextEnabled: boolean) {
    const patch = buildPatch(nextEnabled)
    if (!patch) return
    startSave(async () => {
      const res = await secretSaveAutopilotConfigAction(patch)
      if (res.ok) {
        toast.success(res.message ?? 'Сохранено')
        if (res.config) {
          setEnabled(res.config.enabled)
          onConfigChange?.(res.config)
        }
      } else {
        toast.error(res.message ?? 'Не удалось сохранить')
      }
    })
  }

  function runNow() {
    startRun(async () => {
      const res = await secretRunAutopilotNowAction()
      if (res.ok) toast.success(res.message ?? 'Готово')
      else toast.error(res.message ?? 'Прогон не удался')
    })
  }

  const busy = saving || running

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-7 items-center justify-center rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white">
              <Sparkles className="size-4" />
            </span>
            Искусственный интеллект в чатах
          </DialogTitle>
          <DialogDescription>
            ИИ сам создаёт и ведёт диалоги от имени живых клиентов в выбранных
            каналах. Он строго следует вашей тематике и правилам, и его нельзя
            отличить от реального человека.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-16 text-muted-foreground">
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : (
          <div className="grid gap-5">
            {/* --- Мастер-переключатель --- */}
            <div className="flex items-center justify-between gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {enabled ? 'ИИ включён' : 'ИИ выключен'}
                </p>
                <p className="text-xs text-muted-foreground">
                  {enabled
                    ? 'Диалоги создаются автоматически в рабочее окно'
                    : 'Включите, чтобы ИИ начал работать'}
                </p>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={(v) => save(Boolean(v))}
                disabled={busy}
                aria-label="Включить ИИ"
              />
            </div>

            {/* --- Тематика --- */}
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">
                Тематика и правила (пишите максимально подробно)
              </Label>
              <Textarea
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                rows={7}
                placeholder={
                  'Опишите, о чём пишут клиенты, что они хотят, какой у компании продукт, какие условия, тон общения, что можно и что категорически нельзя. Чем подробнее — тем точнее ИИ следует вам. Например: клиенты интересуются доставкой цветов по Москве, спрашивают цену букета и сроки, торгуются, уточняют состав. Всегда вежливо, коротко, по-человечески.'
                }
                className="resize-none text-sm leading-relaxed"
              />
              <p className="text-[11px] text-muted-foreground">
                Это закон для ИИ. Он никогда не нарушает ваши правила и не
                выходит за тематику.
              </p>
            </div>

            {/* --- Каналы --- */}
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">
                Каналы, в которых создавать диалоги
              </Label>
              {ownedChannels.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border p-3 text-xs text-muted-foreground">
                  Нет каналов с назначенным менеджером. Назначьте менеджера
                  каналу, чтобы выбрать его.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {ownedChannels.map((c) => {
                    const on = selected.has(c.id)
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => toggleChannel(c.id)}
                        className={cn(
                          'rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                          on
                            ? 'border-primary bg-primary text-primary-foreground'
                            : 'border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground',
                        )}
                        aria-pressed={on}
                      >
                        {(TYPE_LABEL[c.type] ?? c.type) + ' · ' + c.name}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>

            {/* --- Рабочее окно (МСК) --- */}
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">
                Рабочее окно, МСК (новые диалоги создаются в это время, хаотично)
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  value={startStr}
                  onChange={(e) => setStartStr(e.target.value)}
                  placeholder="10:00"
                  inputMode="numeric"
                  className="h-9 w-24 text-center"
                  aria-label="Начало рабочего окна"
                />
                <span className="text-muted-foreground">до</span>
                <Input
                  value={endStr}
                  onChange={(e) => setEndStr(e.target.value)}
                  placeholder="22:00"
                  inputMode="numeric"
                  className="h-9 w-24 text-center"
                  aria-label="Конец рабочего окна"
                />
              </div>
            </div>

            {/* --- Интенсивность и глубина --- */}
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Новых диалогов в день
                </Label>
                <Input
                  value={dailyTarget}
                  onChange={(e) =>
                    setDailyTarget(e.target.value.replace(/[^\d]/g, ''))
                  }
                  inputMode="numeric"
                  className="h-9"
                  aria-label="Новых диалогов в день"
                />
              </div>
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">
                  Реплик клиента в диалоге
                </Label>
                <Input
                  value={maxTurns}
                  onChange={(e) =>
                    setMaxTurns(e.target.value.replace(/[^\d]/g, ''))
                  }
                  inputMode="numeric"
                  className="h-9"
                  aria-label="Реплик клиента в диалоге"
                />
              </div>
            </div>

            {/* --- Ведение диалога --- */}
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Отвечать менеджеру</p>
                <p className="text-xs text-muted-foreground">
                  ИИ ведёт переписку как клиент, пока она не завершится
                </p>
              </div>
              <Switch
                checked={replyEnabled}
                onCheckedChange={(v) => setReplyEnabled(Boolean(v))}
                disabled={busy}
                aria-label="Отвечать менеджеру"
              />
            </div>
          </div>
        )}

        {!loading && (
          <DialogFooter className="mt-2 gap-2 sm:justify-between">
            <Button
              variant="outline"
              onClick={runNow}
              disabled={busy || !enabled}
              className="gap-1.5"
              title={enabled ? 'Прогнать сейчас' : 'Сначала включите ИИ'}
            >
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              Прогнать сейчас
            </Button>
            <Button
              onClick={() => save(enabled)}
              disabled={busy}
              className="gap-1.5"
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              Сохранить
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
