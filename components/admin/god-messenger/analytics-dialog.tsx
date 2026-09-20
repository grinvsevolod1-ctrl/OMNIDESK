'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { BarChart3, Loader2, Sparkles, Users } from 'lucide-react'
import { toast } from 'sonner'
import {
  secretGenerateSyntheticDialogsAction,
  secretLeadsAnalyticsAction,
  secretListActiveManagersAction,
  type ActiveManagerRow,
  type LeadsAnalyticsResult,
} from '@/app/actions/admin-secret'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/** Локальная дата YYYY-MM-DD (для input[type=date]). */
function localDate(offsetDays = 0): string {
  const d = new Date()
  d.setDate(d.getDate() + offsetDays)
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 10)
}

/**
 * Аналитика god-мессенджера: сколько лидов написало менеджерам за период (всего
 * и по каждому), плюс блок ИИ-генерации новых лидов на основе всех существующих
 * диалогов. Открывается из шапки списка чатов.
 */
export function AnalyticsDialog({
  open,
  onOpenChange,
  onGenerated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  /** Вызывается после успешной генерации, чтобы родитель обновил список. */
  onGenerated: () => void
}) {
  const [from, setFrom] = useState(() => localDate(-30))
  const [to, setTo] = useState(() => localDate(0))
  const [result, setResult] = useState<LeadsAnalyticsResult | null>(null)
  const [loading, startLoad] = useTransition()

  const [count, setCount] = useState('10')
  const [generating, startGenerate] = useTransition()
  const [managers, setManagers] = useState<ActiveManagerRow[]>([])
  const [managerId, setManagerId] = useState('')

  const load = useCallback(() => {
    startLoad(async () => {
      try {
        const res = await secretLeadsAnalyticsAction({ from, to })
        setResult(res)
      } catch {
        toast.error('Не удалось загрузить аналитику')
      }
    })
  }, [from, to])

  // Загружаем при первом открытии: аналитику и список менеджеров.
  useEffect(() => {
    if (!open) return
    if (!result) load()
    if (managers.length === 0) {
      secretListActiveManagersAction()
        .then(setManagers)
        .catch(() => toast.error('Не удалось загрузить менеджеров'))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const generate = useCallback(() => {
    const n = Math.round(Number(count) || 0)
    if (!n || n < 1) {
      toast.error('Укажите количество диалогов')
      return
    }
    if (n > 100) {
      toast.error('За один раз можно создать не больше 100 диалогов')
      return
    }
    if (!managerId) {
      toast.error('Выберите менеджера')
      return
    }
    startGenerate(async () => {
      const res = await secretGenerateSyntheticDialogsAction({ count: n, managerId })
      if (res.ok) {
        toast.success(res.message)
        onGenerated()
        load() // цифры аналитики сразу учитывают новые лиды
      } else {
        toast.error(res.message)
      }
    })
  }, [count, managerId, load, onGenerated])

  const maxLeads = result?.managers.reduce((m, r) => Math.max(m, r.leads), 0) ?? 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BarChart3 className="size-5 text-primary" />
            Аналитика лидов
          </DialogTitle>
          <DialogDescription>
            Сколько лидов написало менеджерам за период. Выберите даты — период
            учитывается включительно.
          </DialogDescription>
        </DialogHeader>

        {/* --------------------- Выбор периода --------------------- */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">С</Label>
            <Input
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
              className="h-9"
            />
          </div>
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">По</Label>
            <Input
              type="date"
              value={to}
              min={from}
              max={localDate(0)}
              onChange={(e) => setTo(e.target.value)}
              className="h-9"
            />
          </div>
          <Button onClick={load} disabled={loading} className="h-9 gap-1.5">
            {loading && <Loader2 className="size-4 animate-spin" />}
            Показать
          </Button>
        </div>

        {/* ----------------------- Итог ----------------------- */}
        <div className="rounded-xl border border-border bg-muted/40 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Всего лидов за период
          </p>
          <p className="mt-1 text-4xl font-semibold tabular-nums leading-none">
            {loading && !result ? (
              <Loader2 className="size-8 animate-spin text-muted-foreground" />
            ) : (
              (result?.total ?? 0).toLocaleString('ru-RU')
            )}
          </p>
        </div>

        {/* ------------------- Разбивка по менеджерам ------------------- */}
        <div className="grid gap-2">
          <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
            <Users className="size-3.5" />
            По менеджерам
          </div>
          {result && result.managers.length > 0 ? (
            <ul className="grid gap-1.5">
              {result.managers.map((m) => (
                <li key={m.managerId} className="grid gap-1">
                  <div className="flex items-center justify-between gap-2 text-sm">
                    <span className="truncate">{m.managerName}</span>
                    <span className="shrink-0 font-semibold tabular-nums">
                      {m.leads.toLocaleString('ru-RU')}
                    </span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary transition-all"
                      style={{
                        width: `${maxLeads ? Math.max(4, (m.leads / maxLeads) * 100) : 0}%`,
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-3 text-center text-sm text-muted-foreground">
              {loading ? 'Загрузка…' : 'За выбранный период лидов нет.'}
            </p>
          )}
        </div>

        {/* --------------------- Генерация лидов --------------------- */}
        <div className="mt-1 rounded-xl border border-dashed border-border p-4">
          <div className="flex items-center gap-1.5 text-sm font-medium">
            <Sparkles className="size-4 text-primary" />
            Сгенерировать лидов
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
            ИИ проанализирует существующие диалоги и создаст указанное количество
            новых лидов — каждый с одним вступительным сообщением от клиента. Все
            диалоги попадут в инбокс выбранного менеджера.
          </p>
          <div className="mt-3 grid gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Менеджер</Label>
              <Select
                value={managerId}
                onValueChange={(v) => setManagerId(v ?? '')}
                disabled={generating || managers.length === 0}
              >
                <SelectTrigger className="h-9">
                  <SelectValue
                    placeholder={
                      managers.length === 0 ? 'Загрузка…' : 'Выберите менеджера'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {managers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end gap-3">
              <div className="grid gap-1.5">
                <Label className="text-xs text-muted-foreground">Количество</Label>
                <Input
                  type="number"
                  min={1}
                  max={100}
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  className={cn('h-9 w-28')}
                  disabled={generating}
                />
              </div>
              <Button
                onClick={generate}
                disabled={generating || !managerId}
                className="h-9 gap-1.5"
              >
                {generating ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                Создать
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
