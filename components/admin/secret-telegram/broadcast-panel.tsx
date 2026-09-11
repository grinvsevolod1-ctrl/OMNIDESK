'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
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
  createBroadcastAction,
  generateVariantsAction,
  getBroadcastViewAction,
  pauseBroadcastAction,
  regenerateBaseAction,
  removeTargetAction,
  saveBaseTextAction,
  saveVariantAction,
  startBroadcastAction,
  type BroadcastView,
} from '@/app/actions/admin-secret/broadcast'
import type {
  BroadcastCampaign,
  BroadcastTarget,
  TargetStatus,
} from '@/lib/data/broadcast'
import type { PersonalAccountItem } from '@/app/actions/admin-secret/telegram-personal'

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
    label: 'Нужно вручную',
    className: 'text-amber-500',
    icon: TriangleAlert,
  },
  failed: { label: 'Ошибка', className: 'text-destructive', icon: XCircle },
  skipped: { label: 'Пропущено', className: 'text-muted-foreground', icon: XCircle },
}

const RUNNING_STATUSES: TargetStatus[] = [
  'joining',
  'verifying',
  'sending',
]

/**
 * Панель рассылки по группам для одного личного аккаунта. Три фазы:
 *   1. составление — контекст + список групп + параметры пейсинга/капчи
 *   2. проверка — базовый текст (правка/regenerate) + уникальные варианты
 *      под каждую группу + ЕДИНАЯ кнопка «Запустить рассылку»
 *   3. прогресс — живые статусы по группам, пауза/продолжить
 *
 * Всё гейтится requireGod() на сервере; здесь только оркестрация. Часть
 * скрытой god-панели (AGENTS.md §4).
 */
export function BroadcastPanel({
  account,
  onBack,
}: {
  account: PersonalAccountItem
  onBack: () => void
}) {
  const [view, setView] = useState<BroadcastView | null>(null)
  const [loading, setLoading] = useState(true)
  const seqRef = useRef(0)

  const refresh = useCallback(
    async (opts?: { silent?: boolean }) => {
      const seq = ++seqRef.current
      if (!opts?.silent) setLoading(true)
      try {
        const next = await getBroadcastViewAction(account.id)
        if (seqRef.current === seq) setView(next)
      } catch {
        /* фоновая ошибка — оставляем экран как есть */
      } finally {
        if (seqRef.current === seq) setLoading(false)
      }
    },
    [account.id],
  )

  useEffect(() => {
    const kick = setTimeout(() => void refresh({ silent: true }), 0)
    return () => clearTimeout(kick)
  }, [refresh])

  // Пока рассылка идёт — поллим статусы, чтобы прогресс был живым.
  const running = view?.campaign?.status === 'running'
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => {
      if (document.hidden) return
      void refresh({ silent: true })
    }, 4000)
    return () => clearInterval(t)
  }, [running, refresh])

  return (
    <div className="flex h-full flex-col gap-4">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon"
          className="size-9 shrink-0"
          onClick={onBack}
          aria-label="Назад к аккаунтам"
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Send className="size-4 text-primary" />
            Рассылка по группам
          </h2>
          <p className="truncate text-sm text-muted-foreground">
            От имени: {account.name}
          </p>
        </div>
      </div>

      {loading && !view ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-6 animate-spin text-muted-foreground" />
        </div>
      ) : !view?.campaign ? (
        <ComposeStep account={account} onCreated={() => void refresh()} />
      ) : view.campaign.status === 'draft' || view.campaign.status === 'paused' ? (
        <ReviewStep
          campaign={view.campaign}
          targets={view.targets}
          onChanged={() => void refresh()}
        />
      ) : (
        <ProgressStep
          campaign={view.campaign}
          targets={view.targets}
          counts={view.counts}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  )
}

/* ------------------------------- Compose step ------------------------------ */

function ComposeStep({
  account,
  onCreated,
}: {
  account: PersonalAccountItem
  onCreated: () => void
}) {
  const [context, setContext] = useState('')
  const [groups, setGroups] = useState('')
  const [captchaReply, setCaptchaReply] = useState(
    'Я не бот, ознакомлен с правилами',
  )
  const [minDelay, setMinDelay] = useState('45')
  const [maxDelay, setMaxDelay] = useState('90')
  const [pending, startTransition] = useTransition()

  const groupCount = groups
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean).length

  const submit = () => {
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
        await createBroadcastAction({
          channelId: account.id,
          context: context.trim(),
          rawInputs: groups.split('\n'),
          captchaReply: captchaReply.trim(),
          minDelaySec: Number(minDelay),
          maxDelaySec: Number(maxDelay),
        })
        toast.success('Черновик создан, ИИ сформировал текст')
        onCreated()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Не удалось создать')
      }
    })
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
      <Card className="flex flex-col gap-2 p-4">
        <Label htmlFor="bc-context" className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          Контекст сообщения
        </Label>
        <p className="text-xs text-muted-foreground text-pretty">
          Опишите своими словами, что нужно разослать. ИИ превратит это в живой
          пост и сделает уникальный вариант под каждую группу, чтобы обойти
          антиспам-фильтры.
        </p>
        <Textarea
          id="bc-context"
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={4}
          placeholder="Например: ищу подработку курьером на своём авто, свободен вечерами и по выходным, опыт есть, готов приступить сразу."
        />
      </Card>

      <Card className="flex flex-col gap-2 p-4">
        <Label htmlFor="bc-groups" className="flex items-center gap-2">
          <Users className="size-4 text-primary" />
          Группы — по одной в строке
        </Label>
        <p className="text-xs text-muted-foreground text-pretty">
          Ссылки или @username групп подработок. Поддерживаются t.me/name,
          @name, t.me/+инвайт. Аккаунт сам вступит в каждую перед отправкой.
        </p>
        <Textarea
          id="bc-groups"
          value={groups}
          onChange={(e) => setGroups(e.target.value)}
          rows={6}
          className="font-mono text-sm"
          placeholder={'@podrabotka_msk\nt.me/rabota_spb\nt.me/+AbCdEf123456'}
        />
        {groupCount > 0 && (
          <p className="text-xs text-muted-foreground">
            Групп в списке:{' '}
            <span className="font-semibold tabular-nums text-foreground">
              {groupCount}
            </span>
          </p>
        )}
      </Card>

      <Card className="flex flex-col gap-3 p-4">
        <Label className="text-sm font-medium">Параметры рассылки</Label>
        <div className="flex flex-col gap-2">
          <Label htmlFor="bc-captcha" className="text-xs text-muted-foreground">
            Ответ на проверку «ты не бот?»
          </Label>
          <Input
            id="bc-captcha"
            value={captchaReply}
            onChange={(e) => setCaptchaReply(e.target.value)}
            placeholder="Я не бот, ознакомлен с правилами"
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="bc-min" className="text-xs text-muted-foreground">
              Пауза мин. (сек)
            </Label>
            <Input
              id="bc-min"
              type="number"
              inputMode="numeric"
              value={minDelay}
              onChange={(e) => setMinDelay(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="bc-max" className="text-xs text-muted-foreground">
              Пауза макс. (сек)
            </Label>
            <Input
              id="bc-max"
              type="number"
              inputMode="numeric"
              value={maxDelay}
              onChange={(e) => setMaxDelay(e.target.value)}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground text-pretty">
          Случайная пауза между отправками в этих границах имитирует живого
          человека и снижает риск блокировки. Рекомендуем не меньше 45 секунд.
        </p>
      </Card>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-border bg-background/80 py-3 backdrop-blur">
        <Button onClick={submit} disabled={pending}>
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Wand2 className="size-4" />
          )}
          Сформировать текст
        </Button>
      </div>
    </div>
  )
}

/* ------------------------------- Review step ------------------------------- */

function ReviewStep({
  campaign,
  targets,
  onChanged,
}: {
  campaign: BroadcastCampaign
  targets: BroadcastTarget[]
  onChanged: () => void
}) {
  const [baseText, setBaseText] = useState(campaign.baseText)
  const [pending, startTransition] = useTransition()
  const [genPending, startGen] = useTransition()

  const hasVariants = targets.some((t) => t.draftText.trim())
  const activeTargets = targets.filter((t) => t.status !== 'skipped')

  const regenerate = () =>
    startTransition(async () => {
      try {
        const next = await regenerateBaseAction(campaign.id)
        setBaseText(next)
        toast.success('Текст пересоздан')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  const saveBase = () =>
    startTransition(async () => {
      try {
        await saveBaseTextAction(campaign.id, baseText)
        toast.success('Текст сохранён')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  const generateVariants = () =>
    startGen(async () => {
      try {
        await generateVariantsAction(campaign.id)
        toast.success('Варианты под группы готовы')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  const launch = () =>
    startTransition(async () => {
      try {
        await startBroadcastAction(campaign.id)
        toast.success('Рассылка запущена')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
      <Card className="flex flex-col gap-2 p-4">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="bc-base" className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Базовый текст
          </Label>
          <Button
            variant="ghost"
            size="sm"
            onClick={regenerate}
            disabled={pending}
          >
            <RefreshCw className={cn('size-4', pending && 'animate-spin')} />
            Пересоздать
          </Button>
        </div>
        <Textarea
          id="bc-base"
          value={baseText}
          onChange={(e) => setBaseText(e.target.value)}
          rows={5}
        />
        <div className="flex justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={saveBase}
            disabled={pending || baseText === campaign.baseText}
          >
            Сохранить правки
          </Button>
        </div>
      </Card>

      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="font-medium">Группы ({activeTargets.length})</p>
          <p className="text-xs text-muted-foreground text-pretty">
            {hasVariants
              ? 'ИИ сделал уникальный вариант под каждую группу — можно поправить.'
              : 'Сгенерируйте уникальные варианты под каждую группу перед запуском.'}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={generateVariants}
          disabled={genPending || !baseText.trim()}
        >
          {genPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Wand2 className="size-4" />
          )}
          {hasVariants ? 'Пересоздать варианты' : 'Сгенерировать варианты'}
        </Button>
      </div>

      <div className="flex flex-col gap-3">
        {targets.map((t) => (
          <TargetEditRow
            key={t.id}
            campaignId={campaign.id}
            target={t}
            onChanged={onChanged}
          />
        ))}
      </div>

      <div className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-background/80 py-3 backdrop-blur">
        <p className="text-xs text-muted-foreground text-pretty">
          Одна кнопка запускает всю рассылку. Аккаунт вступит в каждую группу,
          пройдёт проверку «ты не бот?» и опубликует пост с паузами{' '}
          {campaign.minDelaySec}–{campaign.maxDelaySec} сек.
        </p>
        <Button
          size="lg"
          onClick={launch}
          disabled={pending || activeTargets.length === 0 || !baseText.trim()}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Play className="size-4" />
          )}
          Запустить рассылку по {activeTargets.length} группам
        </Button>
      </div>
    </div>
  )
}

function TargetEditRow({
  campaignId,
  target,
  onChanged,
}: {
  campaignId: string
  target: BroadcastTarget
  onChanged: () => void
}) {
  const [text, setText] = useState(target.draftText)
  const [pending, startTransition] = useTransition()

  const save = () =>
    startTransition(async () => {
      try {
        await saveVariantAction(campaignId, target.id, text)
        toast.success('Вариант сохранён')
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  const remove = () =>
    startTransition(async () => {
      try {
        await removeTargetAction(campaignId, target.id)
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium">
          {target.resolvedTitle || target.rawInput}
        </p>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
          onClick={remove}
          disabled={pending}
          aria-label="Убрать группу"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        className="text-sm"
        placeholder="Вариант появится после генерации — или впишите вручную."
      />
      {text !== target.draftText && (
        <div className="flex justify-end">
          <Button variant="outline" size="sm" onClick={save} disabled={pending}>
            Сохранить
          </Button>
        </div>
      )}
    </Card>
  )
}

/* ------------------------------ Progress step ------------------------------ */

function ProgressStep({
  campaign,
  targets,
  counts,
  onChanged,
}: {
  campaign: BroadcastCampaign
  targets: BroadcastTarget[]
  counts: Record<TargetStatus, number>
  onChanged: () => void
}) {
  const [pending, startTransition] = useTransition()

  const total = targets.length
  const done = counts.sent + counts.failed + counts.skipped + counts.needs_attention
  const pct = total > 0 ? Math.round((done / total) * 100) : 0
  const isRunning = campaign.status === 'running'

  const pause = () =>
    startTransition(async () => {
      try {
        await pauseBroadcastAction(campaign.id)
        toast.success('Рассылка на паузе')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  const resume = () =>
    startTransition(async () => {
      try {
        await startBroadcastAction(campaign.id)
        toast.success('Рассылка продолжена')
        onChanged()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Ошибка')
      }
    })

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
      <Card className="flex flex-col gap-3 p-4">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <StatusBadge status={campaign.status} />
            <span className="text-sm text-muted-foreground tabular-nums">
              {done} / {total}
            </span>
          </div>
          {isRunning ? (
            <Button variant="outline" size="sm" onClick={pause} disabled={pending}>
              <Pause className="size-4" />
              Пауза
            </Button>
          ) : campaign.status === 'paused' ? (
            <Button size="sm" onClick={resume} disabled={pending}>
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
          <CountChip label="Отправлено" n={counts.sent} tone="ok" />
          <CountChip label="В работе" n={counts.joining + counts.verifying + counts.sending} tone="active" />
          <CountChip label="Ожидают" n={counts.pending} tone="muted" />
          <CountChip label="Вручную" n={counts.needs_attention} tone="warn" />
          <CountChip label="Ошибки" n={counts.failed} tone="bad" />
        </div>

        {campaign.lastError && campaign.status === 'failed' && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive text-pretty">
            {campaign.lastError}
          </p>
        )}
      </Card>

      <div className="flex flex-col gap-2">
        {targets.map((t) => {
          const meta = STATUS_META[t.status]
          const Icon = meta.icon
          const spinning = RUNNING_STATUSES.includes(t.status)
          return (
            <Card key={t.id} className="flex items-center gap-3 p-3">
              <Icon
                className={cn(
                  'size-4 shrink-0',
                  meta.className,
                  spinning && 'animate-spin',
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {t.resolvedTitle || t.rawInput}
                </p>
                {t.error && (
                  <p
                    className="truncate text-xs text-muted-foreground"
                    title={t.error}
                  >
                    {t.error}
                  </p>
                )}
              </div>
              <span className={cn('shrink-0 text-xs font-medium', meta.className)}>
                {meta.label}
              </span>
            </Card>
          )
        })}
      </div>
    </div>
  )
}

function StatusBadge({ status }: { status: BroadcastCampaign['status'] }) {
  const meta: Record<string, { label: string; className: string }> = {
    running: {
      label: 'Идёт рассылка',
      className: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    },
    paused: {
      label: 'На паузе',
      className: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    },
    done: {
      label: 'Завершено',
      className:
        'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    },
    failed: {
      label: 'Остановлено',
      className: 'border-destructive/30 bg-destructive/10 text-destructive',
    },
    draft: { label: 'Черновик', className: 'border-border bg-muted text-muted-foreground' },
  }
  const m = meta[status] ?? meta.draft
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2.5 py-1 text-xs font-medium',
        m.className,
      )}
    >
      {m.label}
    </span>
  )
}

function CountChip({
  label,
  n,
  tone,
}: {
  label: string
  n: number
  tone: 'ok' | 'active' | 'muted' | 'warn' | 'bad'
}) {
  const toneClass: Record<typeof tone, string> = {
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
    active: 'border-sky-500/30 bg-sky-500/10 text-sky-600 dark:text-sky-400',
    muted: 'border-border bg-card text-muted-foreground',
    warn: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400',
    bad: 'border-destructive/30 bg-destructive/10 text-destructive',
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1',
        toneClass[tone],
      )}
    >
      <span className="font-semibold tabular-nums">{n}</span>
      <span className="opacity-80">{label}</span>
    </span>
  )
}
