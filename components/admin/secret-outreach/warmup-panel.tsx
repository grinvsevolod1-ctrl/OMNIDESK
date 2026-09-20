'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import { Loader2, Flame } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  getWarmupConfigAction,
  setWarmupConfigAction,
} from '@/app/actions/admin-secret/outreach-config'
import type { WarmupConfig } from '@/lib/data/outreach-config'

/**
 * Параметры прогрева и лимитов темпа. Воркер перечитывает их на каждом тике,
 * так что менять поведение можно без деплоя.
 */
export function WarmupPanel() {
  const [cfg, setCfg] = useState<WarmupConfig | null>(null)
  const [loading, setLoading] = useState(true)
  const [pending, startTransition] = useTransition()

  // Локальные строковые поля для редактирования.
  const [form, setForm] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    getWarmupConfigAction()
      .then((c) => {
        if (!cancelled) {
          setCfg(c)
          setForm(toForm(c))
        }
      })
      .catch(() => toast.error('Не удалось загрузить параметры'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function upd(key: string, value: string) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  function save() {
    startTransition(async () => {
      try {
        const patch: Partial<WarmupConfig> = {
          passiveDays: num(form.passiveDays),
          mutualDays: num(form.mutualDays),
          liveFromDay: num(form.liveFromDay),
          hourlyCap: num(form.hourlyCap),
          activeHoursStart: num(form.activeHoursStart),
          activeHoursEnd: num(form.activeHoursEnd),
          minDelaySec: num(form.minDelaySec),
          maxDelaySec: num(form.maxDelaySec),
          dailyCapRamp: (form.dailyCapRamp || '')
            .split(',')
            .map((s) => Number(s.trim()))
            .filter((n) => Number.isFinite(n) && n > 0),
          warmGroups: (form.warmGroups || '')
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean),
        }
        const next = await setWarmupConfigAction(patch)
        setCfg(next)
        setForm(toForm(next))
        toast.success('Параметры сохранены')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Ошибка')
      }
    })
  }

  if (loading || !cfg) {
    return (
      <div className="flex justify-center py-12 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-center gap-2">
          <Flame className="size-5 text-primary" />
          <p className="text-sm font-semibold">Прогрев работает автоматически</p>
          <span className="ml-auto inline-flex items-center gap-1.5 rounded-full bg-primary/15 px-2.5 py-0.5 text-xs font-medium text-primary">
            <span className="size-1.5 rounded-full bg-primary animate-pulse" />
            Авторежим
          </span>
        </div>
        <p className="mt-2 text-sm text-muted-foreground text-pretty">
          Ничего запускать вручную не нужно. Как только аккаунт подключён, воркер
          сам ведёт его по расписанию: сначала «живёт» без исходящих чужим —
          читает, заходит и выходит в сеть, ведёт активность внутри пула
          (пассивная фаза и взаимный прогрев), следит за спам-статусом через
          @SpamBot и сбрасывает дневные/часовые счётчики. Аккаунт получает боевые
          касания к лидам только когда созрел ({cfg.liveFromDay} дн.) и чист —
          дневной кап растёт плавно ({cfg.dailyCapRamp.join(' → ')}).
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <AutoStat
          value={`${cfg.passiveDays + cfg.mutualDays} дн.`}
          label="Созревание до боевого режима"
        />
        <AutoStat
          value={`${cfg.activeHoursStart}:00–${cfg.activeHoursEnd}:00 МСК`}
          label="Активные часы (сон ночью)"
        />
        <AutoStat
          value={`${cfg.hourlyCap}/час`}
          label="Потолок касаний зрелого аккаунта"
        />
      </div>

      <details className="group rounded-xl border border-border bg-card/40">
        <summary className="flex cursor-pointer items-center gap-2 p-4 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
          Тонкая настройка (необязательно)
          <span className="ml-auto text-xs text-muted-foreground group-open:hidden">
            Значения по умолчанию подобраны безопасно
          </span>
        </summary>

        <div className="space-y-5 border-t border-border p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Пассивная фаза, дней" k="passiveDays" form={form} upd={upd} />
            <Field label="Взаимный прогрев, дней" k="mutualDays" form={form} upd={upd} />
            <Field label="Боевой режим с дня" k="liveFromDay" form={form} upd={upd} />
            <Field label="Часовой кап отправок" k="hourlyCap" form={form} upd={upd} />
            <Field label="Активные часы с (МСК)" k="activeHoursStart" form={form} upd={upd} />
            <Field label="Активные часы до (МСК)" k="activeHoursEnd" form={form} upd={upd} />
            <Field label="Пауза мин., сек" k="minDelaySec" form={form} upd={upd} />
            <Field label="Пауза макс., сек" k="maxDelaySec" form={form} upd={upd} />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wu-ramp">Рамп дневного капа (через запятую)</Label>
            <Input
              id="wu-ramp"
              value={form.dailyCapRamp || ''}
              onChange={(e) => upd('dailyCapRamp', e.target.value)}
              placeholder="5, 10, 20, 30"
            />
            <p className="text-xs text-muted-foreground">
              День 1 боевого режима — первое число, день 2 — второе и т. д. Дальше
              держится последнее значение.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="wu-groups">
              Группы для прогрева (по одной в строке, необязательно)
            </Label>
            <Textarea
              id="wu-groups"
              value={form.warmGroups || ''}
              onChange={(e) => upd('warmGroups', e.target.value)}
              placeholder={'@some_public_group\n@another_group'}
              rows={4}
            />
            <p className="text-xs text-muted-foreground">
              Прогрев работает и без групп — на присутствии и активности внутри
              пула. Группы лишь добавляют естественности.
            </p>
          </div>

          <div className="flex justify-end">
            <Button onClick={save} disabled={pending} className="gap-1.5">
              {pending && <Loader2 className="size-4 animate-spin" />}
              Сохранить параметры
            </Button>
          </div>
        </div>
      </details>
    </div>
  )
}

function AutoStat({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/40 p-4">
      <p className="text-lg font-semibold text-foreground">{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground text-pretty">{label}</p>
    </div>
  )
}

function Field({
  label,
  k,
  form,
  upd,
}: {
  label: string
  k: string
  form: Record<string, string>
  upd: (k: string, v: string) => void
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`wu-${k}`}>{label}</Label>
      <Input
        id={`wu-${k}`}
        value={form[k] ?? ''}
        onChange={(e) => upd(k, e.target.value)}
        inputMode="numeric"
      />
    </div>
  )
}

function toForm(c: WarmupConfig): Record<string, string> {
  return {
    passiveDays: String(c.passiveDays),
    mutualDays: String(c.mutualDays),
    liveFromDay: String(c.liveFromDay),
    hourlyCap: String(c.hourlyCap),
    activeHoursStart: String(c.activeHoursStart),
    activeHoursEnd: String(c.activeHoursEnd),
    minDelaySec: String(c.minDelaySec),
    maxDelaySec: String(c.maxDelaySec),
    dailyCapRamp: c.dailyCapRamp.join(', '),
    warmGroups: c.warmGroups.join('\n'),
  }
}

function num(s: string | undefined): number {
  const n = Number((s ?? '').trim())
  return Number.isFinite(n) ? n : 0
}
