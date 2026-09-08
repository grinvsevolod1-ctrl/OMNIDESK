'use client'

import { useCallback, useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowRight,
  Check,
  CheckCheck,
  FlipHorizontal2,
  History,
  Loader2,
  RefreshCw,
  Scale,
  Search,
  Send,
  Users,
  X,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import {
  secretDistributeConversationsAction,
  secretListManagerConversationsAction,
  secretListTransferHistoryAction,
  secretReassignConversationsAction,
  secretTransferAllConversationsAction,
  type ReassignConversation,
  type TransferHistoryEntry,
} from '@/app/actions/admin-secret'
import { EmptyState } from '@/components/page-parts'
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
import { cn } from '@/lib/utils'
import type { Manager } from '@/lib/types'

/** Compact "5 мин назад" / date label for a conversation's last activity. */
function relTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffMs = Date.now() - then
  const min = Math.round(diffMs / 60000)
  if (min < 1) return 'только что'
  if (min < 60) return `${min} мин`
  const hrs = Math.round(min / 60)
  if (hrs < 24) return `${hrs} ч`
  const days = Math.round(hrs / 24)
  if (days < 30) return `${days} дн`
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'short',
  })
}

const CHANNEL_FILTERS: { value: string; label: string }[] = [
  { value: 'all', label: 'Все каналы' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'vk', label: 'VK' },
  { value: 'max', label: 'MAX' },
  { value: 'livechat', label: 'Лайв-чат' },
]

type Mode = 'single' | 'distribute'

/**
 * "Передача" tab — redistribute a manager's dialogs.
 *
 * Beyond the original pick-source → tick → pick-target flow it now supports:
 *  - live counters + channel/unread filters over the source manager's dialogs;
 *  - «передать ВСЕ» in one action (ids resolved server-side);
 *  - even distribution of the selection across several managers (load balance);
 *  - a recent-transfers history pulled from the audit trail.
 *
 * All mutations go through admin-scoped server actions that repoint
 * conversations.manager_id (realtime trigger pushes each thread to the new
 * owner live) and write an audit row.
 */
export function SecretTransferTab({ managers }: { managers: Manager[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [loadingList, setLoadingList] = useState(false)

  const [mode, setMode] = useState<Mode>('single')
  const [fromId, setFromId] = useState<string>('')
  const [toId, setToId] = useState<string>('')
  const [distributeTargets, setDistributeTargets] = useState<Set<string>>(
    new Set(),
  )
  const [conversations, setConversations] = useState<ReassignConversation[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')
  const [channel, setChannel] = useState('all')
  const [unreadOnly, setUnreadOnly] = useState(false)
  const [confirmAllOpen, setConfirmAllOpen] = useState(false)

  const [history, setHistory] = useState<TransferHistoryEntry[]>([])

  const sortedManagers = useMemo(
    () => [...managers].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [managers],
  )

  const managerName = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string) => map.get(id) ?? '—'
  }, [managers])

  const loadHistory = useCallback(() => {
    secretListTransferHistoryAction()
      .then(setHistory)
      .catch(() => {
        /* history is best-effort; ignore */
      })
  }, [])

  useEffect(() => {
    loadHistory()
  }, [loadHistory])

  // Reset the list/selection the moment the source manager changes (React's
  // "adjust state when a prop changes" pattern — no setState-in-effect cascade).
  const [trackedFrom, setTrackedFrom] = useState(fromId)
  if (fromId !== trackedFrom) {
    setTrackedFrom(fromId)
    setSelected(new Set())
    setConversations([])
    setLoadingList(Boolean(fromId))
  }

  useEffect(() => {
    if (!fromId) return
    let active = true
    secretListManagerConversationsAction(fromId)
      .then((rows) => {
        if (active) setConversations(rows)
      })
      .catch(() => {
        if (active) toast.error('Не удалось загрузить диалоги')
      })
      .finally(() => {
        if (active) setLoadingList(false)
      })
    return () => {
      active = false
    }
  }, [fromId])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return conversations.filter((c) => {
      if (channel !== 'all' && c.channelType !== channel) return false
      if (unreadOnly && c.unread <= 0) return false
      if (!q) return true
      return (
        c.contactName.toLowerCase().includes(q) ||
        (c.channelName ?? '').toLowerCase().includes(q) ||
        c.lastMessage.toLowerCase().includes(q)
      )
    })
  }, [conversations, search, channel, unreadOnly])

  const totalUnread = useMemo(
    () => conversations.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0),
    [conversations],
  )

  const allVisibleSelected =
    filtered.length > 0 && filtered.every((c) => selected.has(c.id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) for (const c of filtered) next.delete(c.id)
      else for (const c of filtered) next.add(c.id)
      return next
    })
  }

  function invertVisible() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const c of filtered) {
        if (next.has(c.id)) next.delete(c.id)
        else next.add(c.id)
      }
      return next
    })
  }

  function toggleDistributeTarget(id: string) {
    setDistributeTargets((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const targetOptions = sortedManagers.filter((m) => m.id !== fromId)

  async function refreshSource() {
    if (!fromId) return
    const rows = await secretListManagerConversationsAction(fromId)
    setConversations(rows)
    setSelected(new Set())
  }

  const canTransferSelected =
    !pending && !!fromId && !!toId && toId !== fromId && selected.size > 0
  const canDistribute =
    !pending &&
    !!fromId &&
    selected.size > 0 &&
    [...distributeTargets].some((id) => id !== fromId)

  function runOp(op: () => Promise<{ ok: boolean; message: string }>) {
    startTransition(async () => {
      try {
        const res = await op()
        if (res.ok) {
          toast.success(res.message)
          await refreshSource()
          loadHistory()
          router.refresh()
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  function transferSelected() {
    const ids = [...selected]
    runOp(() =>
      secretReassignConversationsAction({
        conversationIds: ids,
        toManagerId: toId,
      }),
    )
  }

  function transferAll() {
    setConfirmAllOpen(false)
    runOp(() =>
      secretTransferAllConversationsAction({
        fromManagerId: fromId,
        toManagerId: toId,
      }),
    )
  }

  function distribute() {
    const ids = [...selected]
    const targets = [...distributeTargets].filter((id) => id !== fromId)
    runOp(() =>
      secretDistributeConversationsAction({
        conversationIds: ids,
        toManagerIds: targets,
      }),
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Controls */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm">
          <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            Выберите менеджера-отправителя, отметьте диалоги и передайте их
            одному менеджеру, распределите между несколькими или передайте все
            разом. Диалоги мгновенно появляются во входящих у новых владельцев.
          </p>
        </div>

        {/* Mode switch */}
        <div
          role="tablist"
          aria-label="Режим передачи"
          className="flex w-fit rounded-lg bg-muted/60 p-0.5"
        >
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'single'}
            onClick={() => setMode('single')}
            className={cn(
              'rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              mode === 'single'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Одному менеджеру
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === 'distribute'}
            onClick={() => setMode('distribute')}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors',
              mode === 'distribute'
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Scale className="size-3.5" />
            Распределить
          </button>
        </div>

        {/* Source + target(s) */}
        <div
          className={cn(
            'grid grid-cols-1 items-end gap-3',
            mode === 'single' && 'sm:grid-cols-[1fr_auto_1fr]',
          )}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="from-manager">От кого</Label>
            <Select value={fromId} onValueChange={(v) => setFromId(v ?? '')}>
              <SelectTrigger id="from-manager">
                <SelectValue placeholder="Выберите менеджера" />
              </SelectTrigger>
              <SelectContent>
                {sortedManagers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {fromId ? (
              <p className="text-xs text-muted-foreground">
                Диалогов: {conversations.length} · непрочитанных: {totalUnread}
              </p>
            ) : null}
          </div>

          {mode === 'single' ? (
            <>
              <div className="hidden justify-center pb-2 sm:flex">
                <ArrowRight className="size-5 text-muted-foreground" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="to-manager">Кому</Label>
                <Select
                  value={toId}
                  onValueChange={(v) => setToId(v ?? '')}
                  disabled={!fromId}
                >
                  <SelectTrigger id="to-manager">
                    <SelectValue placeholder="Выберите менеджера" />
                  </SelectTrigger>
                  <SelectContent>
                    {targetOptions.map((m) => (
                      <SelectItem key={m.id} value={m.id}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </>
          ) : null}
        </div>

        {/* Distribute targets (multi-select chips) */}
        {mode === 'distribute' ? (
          <div className="flex flex-col gap-1.5">
            <Label>Между кем (выберите нескольких)</Label>
            {fromId ? (
              <div className="flex flex-wrap gap-1.5">
                {targetOptions.map((m) => {
                  const on = distributeTargets.has(m.id)
                  return (
                    <button
                      key={m.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() => toggleDistributeTarget(m.id)}
                      className={cn(
                        'press-scale rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                        on
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-input text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {m.name}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Сначала выберите менеджера-отправителя.
              </p>
            )}
          </div>
        ) : null}

        {/* Action bar */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {selected.size > 0
              ? `Выбрано диалогов: ${selected.size}`
              : 'Диалоги не выбраны'}
          </p>
          <div className="flex flex-wrap gap-2">
            {mode === 'single' ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => setConfirmAllOpen(true)}
                  disabled={
                    pending ||
                    !fromId ||
                    !toId ||
                    toId === fromId ||
                    conversations.length === 0
                  }
                  className="gap-1.5"
                >
                  <Send className="size-4" />
                  Передать все ({conversations.length})
                </Button>
                <Button
                  onClick={transferSelected}
                  disabled={!canTransferSelected}
                  className="gap-1.5"
                >
                  {pending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <ArrowRight className="size-4" />
                  )}
                  {toId
                    ? `Передать → ${managerName(toId)}`
                    : 'Передать выбранные'}
                </Button>
              </>
            ) : (
              <Button
                onClick={distribute}
                disabled={!canDistribute}
                className="gap-1.5"
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Scale className="size-4" />
                )}
                Распределить ({selected.size}) между {distributeTargets.size}
              </Button>
            )}
          </div>
        </div>
      </Card>

      {/* Source manager's dialogs */}
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative w-full sm:max-w-xs">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск по диалогам"
                className="pl-8"
                disabled={!fromId}
              />
            </div>
            <Select value={channel} onValueChange={(v) => setChannel(v ?? 'all')}>
              <SelectTrigger className="w-full sm:w-40" disabled={!fromId}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNEL_FILTERS.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              variant={unreadOnly ? 'default' : 'outline'}
              size="sm"
              onClick={() => setUnreadOnly((v) => !v)}
              disabled={!fromId}
              className="gap-1.5"
            >
              Непрочитанные
            </Button>
          </div>
          {filtered.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={toggleAllVisible}
                className="gap-1.5"
              >
                <CheckCheck className="size-4" />
                {allVisibleSelected ? 'Снять все' : 'Выбрать все'}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={invertVisible}
                className="gap-1.5"
              >
                <FlipHorizontal2 className="size-4" />
                Инвертировать
              </Button>
              {selected.size > 0 ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelected(new Set())}
                  className="gap-1.5"
                >
                  <X className="size-4" />
                  Сбросить
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>

        {!fromId ? (
          <div className="p-6">
            <EmptyState
              icon={Users}
              title="Выберите менеджера"
              description="Укажите менеджера-отправителя, чтобы увидеть его диалоги."
            />
          </div>
        ) : loadingList ? (
          <div className="flex items-center justify-center gap-2 p-10 text-sm text-muted-foreground">
            <RefreshCw className="size-4 animate-spin" />
            Загрузка диалогов…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Search}
              title="Диалоги не найдены"
              description={
                search.trim() || channel !== 'all' || unreadOnly
                  ? 'Измените фильтры или запрос поиска.'
                  : 'У этого менеджера нет диалогов.'
              }
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {filtered.map((c) => {
              const isSelected = selected.has(c.id)
              return (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => toggle(c.id)}
                    aria-pressed={isSelected}
                    className={cn(
                      'flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-muted/50',
                      isSelected && 'bg-primary/5',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'flex size-5 shrink-0 items-center justify-center rounded border transition-colors',
                        isSelected
                          ? 'border-primary bg-primary text-primary-foreground'
                          : 'border-input',
                      )}
                    >
                      {isSelected ? <Check className="size-3.5" /> : null}
                    </span>
                    <ChannelIcon
                      type={c.channelType}
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-medium">
                          {c.contactName}
                        </span>
                        {c.unread > 0 ? (
                          <Badge
                            variant="outline"
                            className="border-primary/40 bg-primary/10 text-primary"
                          >
                            {c.unread}
                          </Badge>
                        ) : null}
                      </div>
                      <p className="truncate text-sm text-muted-foreground">
                        {c.lastMessage || 'Нет сообщений'}
                      </p>
                    </div>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {relTime(c.lastMessageAt)}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* History */}
      <Card className="overflow-hidden">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-2">
            <History className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">История передач</h3>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={loadHistory}
            className="gap-1.5"
          >
            <RefreshCw className="size-4" />
            Обновить
          </Button>
        </div>
        {history.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={History}
              title="Пока нет операций"
              description="Здесь появятся последние передачи диалогов."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {history.map((h) => (
              <li
                key={h.id}
                className="flex items-center gap-3 p-3 text-sm"
              >
                <Badge
                  variant="outline"
                  className="shrink-0 border-border text-muted-foreground"
                >
                  {h.kind === 'all'
                    ? 'Все'
                    : h.kind === 'distribute'
                      ? 'Распределение'
                      : 'Передача'}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="truncate">
                    {h.kind === 'distribute'
                      ? `Между ${h.toManagerIds.length} менеджерами`
                      : `→ ${managerName(h.toManagerId)}`}
                    <span className="text-muted-foreground">
                      {' '}
                      · {h.moved} диал.
                    </span>
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {h.actorName}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">
                  {relTime(h.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* Confirm "transfer all" */}
      <Dialog open={confirmAllOpen} onOpenChange={setConfirmAllOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Send className="size-5" />
              Передать все диалоги?
            </DialogTitle>
            <DialogDescription>
              Все диалоги менеджера{' '}
              <span className="font-medium text-foreground">
                {managerName(fromId)}
              </span>{' '}
              ({conversations.length}) будут переданы менеджеру{' '}
              <span className="font-medium text-foreground">
                {managerName(toId)}
              </span>
              . Действие можно повторить в обратную сторону, но не отменить одним
              кликом.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmAllOpen(false)}
              disabled={pending}
            >
              Отмена
            </Button>
            <Button onClick={transferAll} disabled={pending} className="gap-1.5">
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Передать все
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
