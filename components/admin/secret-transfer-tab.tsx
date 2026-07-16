'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowRight,
  Check,
  CheckCheck,
  Loader2,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import {
  secretListManagerConversationsAction,
  secretReassignConversationsAction,
  type ReassignConversation,
} from '@/app/actions/admin-secret'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
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

/**
 * "Передача" tab — hand a manager's dialogs off to another manager.
 *
 * Flow: pick a source manager → their dialogs load → tick the ones to move (or
 * "select all") → pick a target manager → confirm. The move goes through the
 * admin-scoped server action, which repoints conversations.manager_id, writes an
 * audit row and (via the conversations trigger) pushes each thread into the new
 * owner's inbox live. Fully responsive: two stacked cards on mobile, side by
 * side from `lg`.
 */
export function SecretTransferTab({ managers }: { managers: Manager[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [loadingList, setLoadingList] = useState(false)

  const [fromId, setFromId] = useState<string>('')
  const [toId, setToId] = useState<string>('')
  const [conversations, setConversations] = useState<ReassignConversation[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [search, setSearch] = useState('')

  const sortedManagers = useMemo(
    () => [...managers].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [managers],
  )

  const managerName = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string) => map.get(id) ?? '—'
  }, [managers])

  // Load the source manager's dialogs whenever the source changes.
  useEffect(() => {
    if (!fromId) {
      setConversations([])
      setSelected(new Set())
      return
    }
    let active = true
    setLoadingList(true)
    setSelected(new Set())
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
    if (!q) return conversations
    return conversations.filter(
      (c) =>
        c.contactName.toLowerCase().includes(q) ||
        (c.channelName ?? '').toLowerCase().includes(q) ||
        c.lastMessage.toLowerCase().includes(q),
    )
  }, [conversations, search])

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
      if (allVisibleSelected) {
        for (const c of filtered) next.delete(c.id)
      } else {
        for (const c of filtered) next.add(c.id)
      }
      return next
    })
  }

  const canTransfer =
    !pending && !!fromId && !!toId && toId !== fromId && selected.size > 0

  function transfer() {
    const ids = [...selected]
    startTransition(async () => {
      try {
        const res = await secretReassignConversationsAction({
          conversationIds: ids,
          toManagerId: toId,
        })
        if (res.ok) {
          toast.success(res.message)
          // Refresh the source list so moved threads drop off.
          const rows = await secretListManagerConversationsAction(fromId)
          setConversations(rows)
          setSelected(new Set())
          router.refresh()
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  const targetOptions = sortedManagers.filter((m) => m.id !== fromId)

  return (
    <div className="flex flex-col gap-4">
      {/* Controls: from → to */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-2 rounded-lg bg-muted/50 p-3 text-sm">
          <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            Выберите менеджера-отправителя, отметьте нужные диалоги и укажите,
            кому их передать. Диалоги мгновенно появятся в входящих у нового
            менеджера.
          </p>
        </div>

        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-[1fr_auto_1fr]">
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
          </div>

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
        </div>

        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted-foreground">
            {selected.size > 0
              ? `Выбрано диалогов: ${selected.size}`
              : 'Диалоги не выбраны'}
          </p>
          <Button onClick={transfer} disabled={!canTransfer} className="gap-1.5">
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArrowRight className="size-4" />
            )}
            {toId ? `Передать → ${managerName(toId)}` : 'Передать'}
          </Button>
        </div>
      </Card>

      {/* Source manager's dialogs */}
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 sm:flex-row sm:items-center sm:justify-between">
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
          {filtered.length > 0 ? (
            <Button
              variant="outline"
              size="sm"
              onClick={toggleAllVisible}
              className="gap-1.5"
            >
              <CheckCheck className="size-4" />
              {allVisibleSelected ? 'Снять все' : 'Выбрать все'}
            </Button>
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
                search.trim()
                  ? 'Измените запрос поиска.'
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
                    {/* Custom check indicator (no Checkbox primitive in this
                        project); the row button owns the toggle. */}
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
    </div>
  )
}
