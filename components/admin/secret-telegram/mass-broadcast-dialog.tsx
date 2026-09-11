'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import {
  Check,
  CheckCircle2,
  Clock,
  Loader2,
  Megaphone,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  TriangleAlert,
  Users,
  Wand2,
  XCircle,
} from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  createMassBroadcastAction,
  getMassBroadcastViewAction,
  pauseMassBroadcastAction,
  regenerateMassBaseAction,
  saveBaseTextAction,
  startMassBroadcastAction,
  type MassBroadcastView,
} from '@/app/actions/admin-secret/broadcast'
import type { TargetStatus } from '@/lib/data/broadcast'
import type { PersonalAccountItem } from '@/app/actions/admin-secret/telegram-personal'

/**
 * Массовая рассылка: один диалог, три фазы.
 *   1. составление — мультивыбор аккаунтов + список групп + тема + пейсинг
 *   2. проверка — РАЗНЫЙ текст под каждый аккаунт (правка/пересоздать) +
 *      ЕДИНАЯ кнопка «Запустить со всех»
 *   3. прогресс — сводка по каждому аккаунту, пауза/продолжить всю пачку
 *
 * Каждый аккаунт постит во ВСЕ группы своим текстом; кампании тикают на воркере
 * независимо → аккаунты рассылают параллельно. Часть god-панели (requireGod).
 */
export function MassBroadcastDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: PersonalAccountItem[]
}) {
  const [batch, setBatch] = useState<MassBroadcastView | null>(null)

  // Сброс состояния при полном закрытии, чтобы следующий вход был чистым.
  const reset = useCallback(() => setBatch(null), [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent className="flex max-h-[90dvh] w-full max-w-[calc(100%-1rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="shrink-0 border-b border-border px-4 py-4 pr-12 sm:px-5">
          <DialogTitle className="flex items-center gap-2">
            <Megaphone className="size-4 shrink-0 text-primary" />
            Массовая рассылка
          </DialogTitle>
          <DialogDescription className="text-pretty">
            Выберите аккаунты, задайте группы и тему — ИИ сделает разный текст
            для каждого аккаунта, а рассылка пойдёт со всех сразу.
          </DialogDescription>
        </DialogHeader>

        {batch === null ? (
          <MassComposeStep
            accounts={accounts}
            onCreated={setBatch}
          />
        ) : (
          <MassRunView
            initial={batch}
            onExit={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------- Compose step ------------------------------ */

function MassComposeStep({
  accounts,
  onCreated,
}: {
  accounts: PersonalAccountItem[]
  onCreated: (view: MassBroadcastView) => void
}) {
  const online = accounts.filter((a) => a.sessionStatus === 'online')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [context, setContext] = useState('')
  const [groups, setGroups] = useState('')
  const [captchaReply, setCaptchaReply] = useState(
    'Я не бот, ознакомлен с правилами',
  )
  const [minDelay, setMinDelay] = useState('45')
  const [maxDelay, setMaxDelay] = useState('90')
  const [pending, startTransition] = useTransition()

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const allSelected = online.length > 0 && selected.size === online.length
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(online.map((a) => a.id)))

  const groupCount = groups
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean).length

  const submit = () => {
    if (selected.size === 0) {
      toast.error('Выберите хотя бы один аккаунт')
      return
    }
    if (!context.trim()) {
      toast.error('Опишите, о чём сообщение')
      return
    }
    if (groupCount === 0) {
      toast.error('Добавьте хотя бы одну группу')
      return
    }
    startTransition(async () => {
      try {
        const view = await createMassBroadcastAction({
          channelIds: [...selected],
          context: context.trim(),
          rawInputs: groups.split('\n'),
          captchaReply: captchaReply.trim(),
          minDelaySec: Number(minDelay),
          maxDelaySec: Number(maxDelay),
        })
        toast.success('ИИ сформировал текст для каждого аккаунта')
        onCreated(view)
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Не удалось создать')
      }
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-5">
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <Label className="flex items-center gap-2">
            <Users className="size-4 shrink-0 text-primary" />
            Аккаунты для рассылки
          </Label>
          {online.length > 0 && (
            <Button variant="ghost" size="sm" onClick={toggleAll}>
              {allSelected ? 'Снять все' : 'Выбрать все'}
            </Button>
          )}
        </div>
        {online.length === 0 ? (
          <p className="text-sm text-muted-foreground text-pretty">
            Нет аккаунтов в сети. Подключите хотя бы один аккаунт, чтобы
            запустить массовую рассылку.
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {online.map((a) => {
              const on = selected.has(a.id)
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggle(a.id)}
                  className={cn(
                    'flex items-center gap-3 rounded-md border px-3 py-2 text-left transition-colors',
                    on
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-5 shrink-0 items-center justify-center rounded border',
                      on
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-muted-foreground/40',
                    )}
                  >
                    {on && <Check className="size-3.5" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">
                      {a.name}
                    </span>
                    {a.detail && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {a.detail}
                      </span>
                    )}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        {selected.size > 0 && (
          <p className="text-xs text-muted-foreground">
            Выбрано аккаунтов:{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {selected.size}
            </span>
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <Label htmlFor="mbc-context" className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          Тема сообщения
        </Label>
        <p className="text-xs text-muted-foreground text-pretty">
          Опишите, что предлагаете. ИИ сделает РАЗНЫЙ текст для каждого аккаунта
          и доварьирует под каждую группу — аккаунты не будут постить одинаковое.
        </p>
        <Textarea
          id="mbc-context"
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={4}
          placeholder="Например: ищу людей на подработку — расфасовка и упаковка, оплата ежедневная, график свободный, писать в личные сообщения."
        />
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <Label htmlFor="mbc-groups" className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          Группы — по одной в строке
        </Label>
        <p className="text-xs text-muted-foreground text-pretty">
          Каждый выбранный аккаунт вступит и напишет во все эти группы.
          Поддерживаются t.me/name, @name, t.me/+инвайт.
        </p>
        <Textarea
          id="mbc-groups"
          value={groups}
          onChange={(e) => setGroups(e.target.value)}
          rows={5}
          className="font-mono text-sm"
          placeholder={'@podrabotka_msk\nt.me/rabota_spb\nt.me/+AbCdEf123456'}
        />
        {groupCount > 0 && (
          <p className="text-xs text-muted-foreground">
            Групп в списке:{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {groupCount}
            </span>
            {selected.size > 0 && (
              <>
                {' · '}всего отправок:{' '}
                <span className="font-semibold tabular-nums text-foreground">
                  {groupCount * selected.size}
                </span>
              </>
            )}
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <Label className="text-sm font-medium">Параметры рассылки</Label>
        <div className="flex flex-col gap-2">
          <Label htmlFor="mbc-captcha" className="text-xs text-muted-foreground">
            Ответ на проверку «ты не бот?»
          </Label>
          <Input
            id="mbc-captcha"
            value={captchaReply}
            onChange={(e) => setCaptchaReply(e.target.value)}
            placeholder="Я не бот, ознакомлен с правилами"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="mbc-min" className="text-xs text-muted-foreground">
              Пауза мин. (сек)
            </Label>
            <Input
              id="mbc-min"
              type="number"
              inputMode="numeric"
              value={minDelay}
              onChange={(e) => setMinDelay(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="mbc-max" className="text-xs text-muted-foreground">
              Пауза макс. (сек)
            </Label>
            <Input
              id="mbc-max"
              type="number"
              inputMode="numeric"
              value={maxDelay}
              onChange={(e) => setMaxDelay(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground text-pretty">
          Каждый аккаунт держит свои паузы независимо. Рекомендуем не меньше 45
          секунд, чтобы снизить риск блокировки.
        </p>
      </Card>

      <div className="sticky bottom-0 -mx-4 flex justify-end gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur sm:-mx-5 sm:px-5">
        <Button onClick={submit} disabled={pending || online.length === 0}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Wand2 className="size-4" />
          )}
          Сформировать тексты
        </Button>
      </div>
    </div>
  )
}

/* -------------------------- Review + progress view ------------------------- */

function MassRunView({
  initial,
  onExit,
}: {
  initial: MassBroadcastView
  onExit: () => void
}) {
  const [view, setView] = useState<MassBroadcastView>(initial)
  const seqRef = useRef(0)

  const refresh = useCallback(async () => {
    const seq = ++seqRef.current
    try {
      const next = await getMassBroadcastViewAction(initial.batchId)
      if (seqRef.current === seq) setView(next)
    } catch {
      /* фоновая ошибка — оставляем экран как есть */
    }
  }, [initial.batchId])

  const anyRunning = view.campaigns.some((c) => c.campaign.status === 'running')

  // Пока хоть одна кампания идёт — поллим сводку.
  useEffect(() => {
    if (!anyRunning) return
    const t = setInterval(() => {
      if (document.hidden) return
      void refresh()
    }, 4000)
    return () => clearInterval(t)
  }, [anyRunning, refresh])

  const started = view.campaigns.some(
    (c) => c.campaign.status !== 'draft',
  )

  return started ? (
    <MassProgressStep view={view} onChanged={refresh} onExit={onExit} />
  ) : (
    <MassReviewStep view={view} onChanged={refresh} />
  )
}

function MassReviewStep({
  view,
  onChanged,
}: {
  view: MassBroadcastView
  onChanged: () => void
}) {
  const [pending, startTransition] = useTransition()

  const groupsPerAccount = view.campaigns[0]?.targets.length ?? 0
  const totalSends = view.campaigns.reduce((n, c) => n + c.targets.length, 0)

  const launch = () =>
    startTransition(async () => {
      try {
        await startMassBroadcastAction(view.batchId)
        toast.success('Массовая рассылка запущена')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-5">
      <p className="text-sm text-muted-foreground text-pretty">
        ИИ сделал отдельный текст для каждого из {view.campaigns.length}{' '}
        аккаунтов. Проверьте и при желании поправьте — затем одна кнопка запустит
        рассылку со всех сразу.
      </p>

      {view.campaigns.map((c) => (
        <AccountTextCard
          key={c.campaign.id}
          campaignId={c.campaign.id}
          accountName={c.accountName}
          groupsCount={c.targets.length}
          initialText={c.campaign.baseText}
        />
      ))}

      <div className="sticky bottom-0 -mx-4 flex flex-col gap-2 border-t border-border bg-background/90 px-4 py-3 backdrop-blur sm:-mx-5 sm:px-5">
        <p className="text-xs text-muted-foreground text-pretty">
          {view.campaigns.length} аккаунтов × {groupsPerAccount} групп ={' '}
          <span className="font-semibold text-foreground">{totalSends}</span>{' '}
          отправок. Каждый аккаунт вступит в группы, пройдёт проверку «ты не
          бот?» и опубликует свой текст с паузами.
        </p>
        <Button size="lg" onClick={launch} disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Запустить со всех {view.campaigns.length} аккаунтов
        </Button>
      </div>
    </div>
  )
}

function AccountTextCard({
  campaignId,
  accountName,
  groupsCount,
  initialText,
}: {
  campaignId: string
  accountName: string
  groupsCount: number
  initialText: string
}) {
  const [text, setText] = useState(initialText)
  const [saved, setSaved] = useState(initialText)
  const [pending, startTransition] = useTransition()
  const [genPending, startGen] = useTransition()

  const save = () =>
    startTransition(async () => {
      try {
        await saveBaseTextAction(campaignId, text)
        setSaved(text)
        toast.success('Текст сохранён')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  const regenerate = () =>
    startGen(async () => {
      try {
        const next = await regenerateMassBaseAction(campaignId)
        setText(next)
        setSaved(next)
        toast.success('Текст пересоздан')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  return (
    <Card className="flex flex-col gap-2 p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{accountName}</p>
          <p className="text-xs text-muted-foreground">
            во все {groupsCount} групп
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={regenerate}
          disabled={genPending}
        >
          <RefreshCw className={cn('size-4', genPending && 'animate-spin')} />
          Пересоздать
        </Button>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={4}
        className="text-sm"
      />
      {text !== saved && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={save} disabled={pending}>
            Сохранить правки
          </Button>
        </div>
      )}
    </Card>
  )
}

/* ------------------------------ Progress step ------------------------------ */

const STATUS_META: Record<
  TargetStatus,
  { label: string; className: string; icon: typeof CheckCircle2 }
> = {
  pending: { label: 'Ожидает', className: 'text-muted-foreground', icon: Clock },
  joining: { label: 'Вступаем', className: 'text-sky-500', icon: Loader2 },
  verifying: { label: 'Проверка', className: 'text-sky-500', icon: Loader2 },
  sending: { label: 'Отправка', className: 'text-sky-500', icon: Loader2 },
  sent: { label: 'Отправлено', className: 'text-emerald-500', icon: CheckCircle2 },
  needs_attention: {
    label: 'Вручную',
    className: 'text-amber-500',
    icon: TriangleAlert,
  },
  failed: { label: 'Ошибка', className: 'text-destructive', icon: XCircle },
  skipped: { label: 'Пропущено', className: 'text-muted-foreground', icon: XCircle },
}

function MassProgressStep({
  view,
  onChanged,
  onExit,
}: {
  view: MassBroadcastView
  onChanged: () => void
  onExit: () => void
}) {
  const [pending, startTransition] = useTransition()

  const totals = view.campaigns.reduce(
    (acc, c) => {
      const total = c.targets.length
      const done =
        c.counts.sent +
        c.counts.failed +
        c.counts.skipped +
        c.counts.needs_attention
      acc.total += total
      acc.done += done
      acc.sent += c.counts.sent
      acc.attention += c.counts.needs_attention
      acc.failed += c.counts.failed
      return acc
    },
    { total: 0, done: 0, sent: 0, attention: 0, failed: 0 },
  )
  const pct = totals.total > 0 ? Math.round((totals.done / totals.total) * 100) : 0
  const anyRunning = view.campaigns.some((c) => c.campaign.status === 'running')
  const allDone = totals.total > 0 && totals.done >= totals.total

  const pauseAll = () =>
    startTransition(async () => {
      try {
        await pauseMassBroadcastAction(view.batchId)
        toast.success('Рассылка на паузе')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  const resumeAll = () =>
    startTransition(async () => {
      try {
        await startMassBroadcastAction(view.batchId)
        toast.success('Рассылка продолжена')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4 sm:px-5">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium">
            Прогресс:{' '}
            <span className="tabular-nums">
              {totals.done} / {totals.total}
            </span>
          </span>
          {anyRunning ? (
            <Button variant="outline" size="sm" onClick={pauseAll} disabled={pending}>
              <Pause className="size-4" />
              Пауза
            </Button>
          ) : !allDone ? (
            <Button size="sm" onClick={resumeAll} disabled={pending}>
              <Play className="size-4" />
              Продолжить
            </Button>
          ) : null}
        </div>
        <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <Chip label="Отправлено" n={totals.sent} tone="ok" />
          <Chip label="Вручную" n={totals.attention} tone="warn" />
          <Chip label="Ошибки" n={totals.failed} tone="bad" />
        </div>
      </Card>

      {view.campaigns.map((c) => {
        const total = c.targets.length
        const done =
          c.counts.sent +
          c.counts.failed +
          c.counts.skipped +
          c.counts.needs_attention
        return (
          <Card key={c.campaign.id} className="flex flex-col gap-2 p-4">
            <div className="flex items-center justify-between gap-2">
              <p className="truncate text-sm font-medium">{c.accountName}</p>
              <span className="text-xs text-muted-foreground tabular-nums">
                {done} / {total}
              </span>
            </div>
            <div className="flex flex-col gap-1">
              {c.targets.map((t) => {
                const meta = STATUS_META[t.status]
                const Icon = meta.icon
                const spinning =
                  t.status === 'joining' ||
                  t.status === 'verifying' ||
                  t.status === 'sending'
                return (
                  <div
                    key={t.id}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="truncate text-muted-foreground">
                      {t.resolvedTitle || t.rawInput}
                    </span>
                    <span
                      className={cn(
                        'flex shrink-0 items-center gap-1',
                        meta.className,
                      )}
                    >
                      <Icon className={cn('size-3.5', spinning && 'animate-spin')} />
                      {meta.label}
                    </span>
                  </div>
                )
              })}
            </div>
            {c.campaign.lastError && c.campaign.status === 'failed' && (
              <p className="rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-xs text-destructive text-pretty">
                {c.campaign.lastError}
              </p>
            )}
          </Card>
        )
      })}

      <div className="sticky bottom-0 -mx-5 flex justify-end border-t border-border bg-background/90 px-5 py-3 backdrop-blur">
        <Button variant="outline" onClick={onExit}>
          Закрыть
        </Button>
      </div>
    </div>
  )
}

function Chip({
  label,
  n,
  tone,
}: {
  label: string
  n: number
  tone: 'ok' | 'warn' | 'bad'
}) {
  const toneClass =
    tone === 'ok'
      ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
      : tone === 'warn'
        ? 'border-amber-500/30 text-amber-600 dark:text-amber-400'
        : 'border-destructive/30 text-destructive'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5',
        toneClass,
      )}
    >
      {label}: <span className="font-semibold tabular-nums">{n}</span>
    </span>
  )
}
