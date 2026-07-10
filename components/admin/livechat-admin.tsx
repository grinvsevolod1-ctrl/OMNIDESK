'use client'

import { useEffect, useState, useTransition } from 'react'
import {
  Check,
  Copy,
  Loader2,
  MessageCircle,
  Plus,
  Trash2,
  Users,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  createLivechatAction,
  deleteLivechatAction,
  updateLivechatPoolAction,
} from '@/app/actions/livechat'
import { WidgetEditor } from '@/components/admin/widget-editor'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { LivechatAdminChannel } from '@/lib/data'
import type { Manager } from '@/lib/types'

/**
 * Read-only widget status, derived from the channel `status` field which is the
 * single source of truth (mirrors the server's isLivechatConnected). The badge
 * only reads "Active" once the widget has actually connected from the live site
 * (status 'connected'); a freshly created integration stays "Not integrated"
 * (status 'pending') until the snippet goes live, so the admin never shows a
 * false positive before the chat is really installed.
 */
function WidgetStatus({ status }: { status: LivechatAdminChannel['status'] }) {
  const connected = status === 'connected'
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        connected
          ? 'border-emerald-500/30 text-emerald-600 dark:text-emerald-400'
          : 'border-amber-500/30 text-amber-600 dark:text-amber-400',
      )}
    >
      <span
        className={cn(
          'size-1.5 rounded-full',
          connected ? 'bg-emerald-500' : 'bg-amber-500',
        )}
      />
      {connected ? 'Активен' : 'Не интегрирован'}
    </span>
  )
}

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/**
 * Ordered multi-select for the manager queue. Selection order IS the
 * round-robin order, shown as a numbered badge on each chosen manager.
 */
function QueuePicker({
  managers,
  selected,
  onChange,
}: {
  managers: Manager[]
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  function toggle(id: string) {
    onChange(
      selected.includes(id)
        ? selected.filter((x) => x !== id)
        : [...selected, id],
    )
  }
  return (
    <div className="flex max-h-56 flex-col gap-1 overflow-y-auto rounded-lg border border-border p-1.5">
      {managers.map((m) => {
        const pos = selected.indexOf(m.id)
        const active = pos !== -1
        return (
          <button
            key={m.id}
            type="button"
            onClick={() => toggle(m.id)}
            className={cn(
              'flex items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left text-sm transition-colors',
              active ? 'bg-primary/10' : 'hover:bg-muted/50',
            )}
          >
            <span className="flex min-w-0 items-center gap-2.5">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium',
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-secondary text-muted-foreground',
                )}
              >
                {active ? pos + 1 : initials(m.name)}
              </span>
              <span className="truncate">{m.name}</span>
            </span>
            {active ? (
              <Check className="size-4 shrink-0 text-primary" />
            ) : null}
          </button>
        )
      })}
    </div>
  )
}

export function LivechatAdmin({
  channels,
  managers,
}: {
  channels: LivechatAdminChannel[]
  managers: Manager[]
}) {
  const [open, setOpen] = useState(false)
  const [pool, setPool] = useState<string[]>([])
  const [apiKey, setApiKey] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [origin, setOrigin] = useState('')

  useEffect(() => {
    // Read the real origin on the client so generated snippet/webhook URLs match
    // the browser address. Safe one-shot state set on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setOrigin(window.location.origin)
  }, [])

  const base = origin || 'https://your-panel-domain.com'

  function submit(formData: FormData) {
    formData.set('managerIds', pool.join(','))
    startTransition(async () => {
      const res = await createLivechatAction(formData)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      if (res.apiKey) setApiKey(res.apiKey)
    })
  }

  function closeDialog() {
    setOpen(false)
    setTimeout(() => {
      setApiKey(null)
      setPool([])
    }, 150)
  }

  function remove(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await deleteLivechatAction(id)
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
      setBusyId(null)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <Dialog
          open={open}
          onOpenChange={(o) => (o ? setOpen(true) : closeDialog())}
        >
          <DialogTrigger
            render={
              <Button>
                <Plus className="size-4" />
                Новый онлайн-чат
              </Button>
            }
          />
          <DialogContent className="flex max-h-[90vh] flex-col overflow-hidden sm:max-w-lg">
            {!apiKey ? (
              <form action={submit} className="flex min-h-0 flex-col">
                <DialogHeader>
                  <DialogTitle>Подключить онлайн-чат на сайт</DialogTitle>
                  <DialogDescription>
                    Сгенерируйте API-ключ и назначьте очередь менеджеров.
                    Посетители распределяются по очереди по принципу round-robin;
                    повторные посетители остаются за назначенным менеджером.
                  </DialogDescription>
                </DialogHeader>
                <div className="my-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="lc-name">Отображаемое имя</Label>
                    <Input id="lc-name" name="name" placeholder="Виджет acme.com" />
                  </div>
                  <div className="flex flex-col gap-2">
                    <Label htmlFor="lc-domain">Домен сайта</Label>
                    <Input
                      id="lc-domain"
                      name="domain"
                      placeholder="acme.com (необязательно)"
                    />
                    <p className="text-xs text-muted-foreground">
                      Только для справки. Доступ определяется API-ключом —
                      виджет работает на любом домене, заполнять поле
                      необязательно.
                    </p>
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                      <Label>Очередь менеджеров</Label>
                      <span className="text-xs text-muted-foreground">
                        выбрано: {pool.length}
                      </span>
                    </div>
                    <QueuePicker
                      managers={managers}
                      selected={pool}
                      onChange={setPool}
                    />
                    <p className="text-xs text-muted-foreground">
                      Порядок = порядок распределения. 1-й посетитель идёт к №1,
                      2-й — к №2 и так далее.
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2">
                  <Button type="button" variant="outline" onClick={closeDialog}>
                    Отмена
                  </Button>
                  <Button type="submit" disabled={pending || pool.length === 0}>
                    {pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : null}
                    Сгенерировать ключ
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex min-h-0 flex-col">
                <DialogHeader>
                  <DialogTitle>Установка виджета</DialogTitle>
                  <DialogDescription>
                    Выполните эти шаги, чтобы запустить чат на сайте.
                  </DialogDescription>
                </DialogHeader>
                <div className="my-4 min-h-0 flex-1 overflow-y-auto">
                  <Instructions apiKey={apiKey} base={base} />
                </div>
                <div className="flex justify-end">
                  <Button onClick={closeDialog}>Готово</Button>
                </div>
              </div>
            )}
          </DialogContent>
        </Dialog>
      </div>

      {channels.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Онлайн-чатов пока нет. Создайте чат, установите сниппет на сайт — и
          очередь менеджеров начнёт получать сообщения.
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {channels.map((c) => (
            <Card key={c.id} className="flex flex-col gap-3 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <MessageCircle className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-sm font-medium">{c.name}</p>
                      <WidgetStatus status={c.status} />
                    </div>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {c.domain || '—'}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <WidgetEditor
                    channelId={c.id}
                    channelName={c.name}
                    domain={c.domain}
                    initialConfig={c.widget}
                    base={base}
                  />
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`Remove ${c.name}`}
                    onClick={() => remove(c.id)}
                    disabled={pending && busyId === c.id}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                    <Users className="size-3.5" />
                    Очередь менеджеров ({c.pool.length})
                  </span>
                  <EditQueue
                    channel={c}
                    managers={managers}
                    disabled={pending}
                  />
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {c.poolNames.length > 0 ? (
                    c.poolNames.map((n, i) => (
                      <Badge
                        key={`${c.id}-${i}`}
                        variant="secondary"
                        className="gap-1 font-normal"
                      >
                        <span className="text-muted-foreground">{i + 1}.</span>
                        {n}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      Менеджеры не назначены
                    </span>
                  )}
                </div>
              </div>

              <details className="group">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                  Показать инструкцию по установке
                </summary>
                <div className="mt-3">
                  <Instructions apiKey={c.apiKey} base={base} />
                </div>
              </details>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}

/** Dialog to edit an existing channel's manager queue. */
function EditQueue({
  channel,
  managers,
  disabled,
}: {
  channel: LivechatAdminChannel
  managers: Manager[]
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [pool, setPool] = useState<string[]>(channel.pool)
  const [pending, startTransition] = useTransition()

  // Reset selection to the saved queue whenever the dialog opens.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) setPool(channel.pool)
  }, [open, channel.pool])

  function save() {
    startTransition(async () => {
      const res = await updateLivechatPoolAction(channel.id, pool)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setOpen(false)
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm" disabled={disabled} className="h-7 px-2 text-xs">
            Изменить
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Очередь менеджеров</DialogTitle>
          <DialogDescription>
            Выберите менеджеров для {channel.name}. Порядок выбора задаёт порядок
            распределения round-robin.
          </DialogDescription>
        </DialogHeader>
        <div className="my-3 flex flex-col gap-2">
          <QueuePicker managers={managers} selected={pool} onChange={setPool} />
          <span className="text-xs text-muted-foreground">
            выбрано: {pool.length}
          </span>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button onClick={save} disabled={pending || pool.length === 0}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Сохранить очередь
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The one and only install snippet: a single async <script> tag that loads the
 * widget straight from the panel and carries only the API key. It works on any
 * site (HTML, React, Next.js, anything) and on any domain. Everything visual
 * (colours, texts, position, on/off) is controlled from the admin and fetched
 * live by the key, so installing once is enough — forever.
 */
function htmlSnippet(apiKey: string, base: string): string {
  return `<script async src="${base.replace(/\/$/, '')}/widget.js" data-support-key="${apiKey}"></script>`
}

function Instructions({ apiKey, base }: { apiKey: string; base: string }) {
  return (
    <ol className="flex flex-col gap-3 text-sm">
      <li className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          1. Скопируйте этот код и вставьте его в HTML страницы — лучше всего
          перед закрывающим тегом{' '}
          <span className="font-mono">{'</body>'}</span>
        </span>
        <CopyField value={htmlSnippet(apiKey, base)} />
        <p className="text-xs text-muted-foreground">
          Подходит для любого сайта и любого фреймворка. В React/Next.js
          добавьте тот же тег в разметку (например, в{' '}
          <span className="font-mono">app/layout.tsx</span> внутри{' '}
          <span className="font-mono">{'<body>'}</span>).
        </p>
      </li>
      <li className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          2. Готово — дальше всё меняется из админки
        </span>
        <p className="text-xs text-muted-foreground">
          Цвет, тексты, позиция, аватар, быстрые ответы, рабочие часы и
          включение/выключение виджета настраиваются здесь, в панели, и
          применяются на сайте автоматически — менять код на сайте больше
          никогда не нужно.
        </p>
      </li>
    </ol>
  )
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard.writeText(value)
    setCopied(true)
    toast.success('Скопировано')
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex items-start gap-2">
      {/* Wrap long snippets instead of showing an ugly horizontal scrollbar.
          `min-w-0` lets the flex child shrink; `break-all` + `pre-wrap` keep
          the code fully visible and selectable on any width. */}
      <pre className="min-w-0 flex-1 rounded-lg border border-border bg-background p-2.5 text-xs leading-relaxed">
        <code className="block whitespace-pre-wrap break-all font-mono">
          {value}
        </code>
      </pre>
      <Button
        variant="outline"
        size="icon-sm"
        onClick={copy}
        aria-label="Скопировать"
        className="shrink-0"
      >
        {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      </Button>
    </div>
  )
}
