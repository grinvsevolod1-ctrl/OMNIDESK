'use client'

/**
 * Channels tab for the secret dashboard: searchable/filterable channel list
 * with per-row admin actions (pause ingest, connect/disconnect, delete), plus
 * the create-channel dialog and a shared confirm-delete button. Extracted from
 * the secret-dashboard monolith; props-driven via a shared `run` dispatcher.
 */

import { useOptimistic, useTransition, useState } from 'react'
import {
  Antenna,
  Copy,
  Loader2,
  Pause,
  Play,
  Plus,
  Search,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserX,
} from 'lucide-react'
import {
  secretCreateChannelAction,
  secretDeleteChannelAction,
  secretKickForeignSessionsAction,
  secretSetChannelStatusAction,
  secretSetTelegramExclusiveAction,
  secretToggleChannelIngestAction,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { ChannelIcon } from '@/components/channel-icons'
import { StatusBadge, SessionBadge, EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { toast } from 'sonner'
import type { Channel, Manager } from '@/lib/types'
import { copyText, TYPE_LABEL } from '@/components/admin/secret-dashboard/utils'

export function ChannelsTab({
  channels,
  managers,
  managerName,
  pending,
  run,
  tgExclusive,
}: {
  channels: Channel[]
  managers: Manager[]
  managerName: (id: string | null) => string
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
  /** Current value of the Telegram exclusive-session enforcement flag. */
  tgExclusive: boolean
}) {
  const [q, setQ] = useState('')
  const [typeFilter, setTypeFilter] = useState<string>('all')

  const filtered = channels.filter((c) => {
    const matchesQ =
      c.name.toLowerCase().includes(q.toLowerCase()) ||
      (c.detail ?? '').toLowerCase().includes(q.toLowerCase())
    const matchesType = typeFilter === 'all' || c.type === typeFilter
    return matchesQ && matchesType
  })

  const [optimisticExclusive, setOptimisticExclusive] = useOptimistic(tgExclusive)
  const [toggling, startToggle] = useTransition()
  const [kicking, setKicking] = useState(false)

  function handleExclusiveToggle(next: boolean) {
    startToggle(async () => {
      setOptimisticExclusive(next)
      try {
        const res = await secretSetTelegramExclusiveAction(next)
        if (res.ok) {
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось изменить настройку')
      }
    })
  }

  function handleKickNow() {
    setKicking(true)
    void secretKickForeignSessionsAction().then((res) => {
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
    }).catch(() => {
      toast.error('Не удалось отправить команду')
    }).finally(() => {
      setKicking(false)
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Exclusive-session security card */}
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <div
              className={[
                'flex size-9 shrink-0 items-center justify-center rounded-lg border',
                optimisticExclusive
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : 'border-border bg-muted/40',
              ].join(' ')}
            >
              {optimisticExclusive ? (
                <ShieldCheck className="size-4 text-emerald-500" />
              ) : (
                <ShieldOff className="size-4 text-muted-foreground" />
              )}
            </div>
            <div>
              <p className="font-medium">Эксклюзивная сессия Telegram</p>
              <p className="mt-0.5 max-w-prose text-sm text-muted-foreground">
                {optimisticExclusive
                  ? 'Любая посторонняя авторизация на подключённом аккаунте завершается автоматически — сразу при входе и каждые 2 минуты. Менеджер не увидит предупреждения.'
                  : 'Отключено. Другие устройства могут подключаться к аккаунту без кика.'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2 sm:pt-0.5">
            <div className="flex items-center gap-2">
              <Label
                htmlFor="tg-exclusive-switch"
                className="cursor-pointer select-none text-sm"
              >
                {optimisticExclusive ? 'Включено' : 'Выключено'}
              </Label>
              <Switch
                id="tg-exclusive-switch"
                checked={optimisticExclusive}
                disabled={toggling}
                onCheckedChange={handleExclusiveToggle}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={kicking}
              onClick={handleKickNow}
            >
              {kicking ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <UserX className="size-3.5" />
              )}
              Кикнуть сейчас
            </Button>
          </div>
        </div>
      </Card>

      {/* Channel list card */}
      <Card className="overflow-hidden">
      <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-1 flex-col gap-2 sm:flex-row">
          <div className="relative w-full sm:max-w-xs">
            <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Поиск канала"
              className="pl-8"
            />
          </div>
          <Select value={typeFilter} onValueChange={(v) => setTypeFilter(v ?? 'all')}>
            <SelectTrigger className="w-full sm:w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все типы</SelectItem>
              {Object.entries(TYPE_LABEL).map(([v, l]) => (
                <SelectItem key={v} value={v}>
                  {l}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <CreateChannelDialog managers={managers} pending={pending} run={run} />
      </div>

      {filtered.length ? (
        <div className="divide-y divide-border">
          {filtered.map((ch) => {
            return (
              <div
                key={ch.id}
                className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex items-start gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <ChannelIcon type={ch.type} className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{ch.name}</span>
                      <Badge variant="secondary">{TYPE_LABEL[ch.type] ?? ch.type}</Badge>
                      <StatusBadge status={ch.status} />
                      {ch.type === 'telegram' || ch.type === 'whatsapp' ? (
                        <SessionBadge status={ch.sessionStatus} />
                      ) : null}
                      {ch.ingestPaused ? (
                        <Badge variant="outline" className="border-warning/40 text-warning">
                          Приём на паузе
                        </Badge>
                      ) : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">
                      {ch.detail || '—'} · Владелец: {managerName(ch.managerId)}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => copyText(ch.id)}
                    className="gap-1.5"
                  >
                    <Copy className="size-3.5" /> ID
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => secretToggleChannelIngestAction(ch.id))}
                    className="gap-1.5"
                  >
                    {ch.ingestPaused ? (
                      <>
                        <Play className="size-3.5" /> Возобновить
                      </>
                    ) : (
                      <>
                        <Pause className="size-3.5" /> Пауза
                      </>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        secretSetChannelStatusAction(
                          ch.id,
                          ch.status === 'connected' ? 'disconnected' : 'connected',
                        ),
                      )
                    }
                    className="gap-1.5"
                  >
                    <Antenna className="size-3.5" />
                    {ch.status === 'connected' ? 'Отключить' : 'Подключить'}
                  </Button>
                  <ConfirmDeleteButton
                    label="канал"
                    name={ch.name}
                    pending={pending}
                    onConfirm={() => run(() => secretDeleteChannelAction(ch.id))}
                  />
                </div>
              </div>
            )
          })}
        </div>
      ) : (
        <div className="p-6">
          <EmptyState
            icon={Antenna}
            title="Каналы не найдены"
            description="Создайте новый канал или измените фильтры."
          />
        </div>
      )}
    </Card>
    </div>
  )
}

function CreateChannelDialog({
  managers,
  pending,
  run,
}: {
  managers: Manager[]
  pending: boolean
  run: (a: () => Promise<ActionResult>, onDone?: () => void) => void
}) {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState({
    name: '',
    type: 'telegram',
    managerId: '',
    phone: '',
    token: '',
    groupId: '',
  })

  return (
    <>
      <Button size="sm" className="gap-1.5" onClick={() => setOpen(true)}>
        <Plus className="size-4" /> Новый канал
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Создать канал</DialogTitle>
          <DialogDescription>
            Ручное создание записи канала. Для реального подключения Telegram/WhatsApp
            используйте мастер в разделе «Аккаунты».
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Название</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Напр. Основной Telegram"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Тип</Label>
              <Select
                value={form.type}
                onValueChange={(v) => setForm({ ...form, type: v ?? '' })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {Object.entries(TYPE_LABEL).map(([v, l]) => (
                    <SelectItem key={v} value={v}>
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-1.5">
              <Label>Владелец</Label>
              <Select
                value={form.managerId}
                onValueChange={(v) => setForm({ ...form, managerId: v ?? '' })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Менеджер" />
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
          </div>
          <div className="grid gap-1.5">
            <Label>Телефон / деталь</Label>
            <Input
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
              placeholder="Необязательно"
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            disabled={pending}
            onClick={() =>
              run(
                () => secretCreateChannelAction(form),
                () => {
                  setOpen(false)
                  setForm({
                    name: '',
                    type: 'telegram',
                    managerId: '',
                    phone: '',
                    token: '',
                    groupId: '',
                  })
                },
              )
            }
            className="gap-1.5"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  )
}

/* ------------------------------ Shared UI ----------------------------- */

function ConfirmDeleteButton({
  label,
  name,
  pending,
  onConfirm,
}: {
  label: string
  name: string
  pending: boolean
  onConfirm: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="gap-1.5 text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" /> Удалить
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Удалить {label}?</DialogTitle>
          <DialogDescription>
            «{name}» будет удалён безвозвратно вместе со связанными данными.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Отмена
          </Button>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => {
              onConfirm()
              setOpen(false)
            }}
            className="gap-1.5"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Удалить
          </Button>
        </DialogFooter>
      </DialogContent>
      </Dialog>
    </>
  )
}
