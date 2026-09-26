'use client'

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  AlertTriangle,
  CheckCheck,
  FlipHorizontal2,
  Loader2,
  Search,
  Trash2,
  TriangleAlert,
  X,
} from 'lucide-react'
import {
  secretHardDeleteConversationsAction,
  secretSearchConversationsAction,
  type DialogDateField,
  type DialogKindFilter,
  type DialogSearchRow,
} from '@/app/actions/admin-secret'
import { ChannelIcon } from '@/components/channel-icons'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Check } from 'lucide-react'
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
import { cn } from '@/lib/utils'
import type { ChannelType, Manager } from '@/lib/types'

const CHANNEL_OPTIONS: { value: ChannelType | 'all'; label: string }[] = [
  { value: 'all', label: 'Все каналы' },
  { value: 'telegram', label: 'Telegram' },
  { value: 'telegram_personal', label: 'Telegram (личный)' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'vk', label: 'VK' },
  { value: 'max', label: 'MAX' },
  { value: 'livechat', label: 'Лайв-чат' },
]

const KIND_OPTIONS: { value: DialogKindFilter; label: string }[] = [
  { value: 'all', label: 'Любые' },
  { value: 'real', label: 'Реальные' },
  { value: 'synthetic', label: 'Синтетические' },
  { value: 'simulated', label: 'Симуляция' },
]

const DATE_FIELD_OPTIONS: { value: DialogDateField; label: string }[] = [
  { value: 'created_at', label: 'по дате создания' },
  { value: 'last_message_at', label: 'по последней активности' },
]

function fmtDateTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const CONFIRM_WORD = 'УДАЛИТЬ'

/**
 * «Удаление диалогов» — god-only search over EVERY conversation in the system
 * plus an irreversible hard delete. Search runs on demand (server action); the
 * delete requires typing a confirmation word and cannot be undone.
 */
export function SecretDialogsTab({ managers }: { managers: Manager[] }) {
  const [pending, startTransition] = useTransition()
  const [searching, setSearching] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  // Filters
  const [q, setQ] = useState('')
  const [searchMessages, setSearchMessages] = useState(false)
  const [channelType, setChannelType] = useState<ChannelType | 'all'>('all')
  const [managerId, setManagerId] = useState<string>('all')
  const [kind, setKind] = useState<DialogKindFilter>('all')
  const [dateField, setDateField] = useState<DialogDateField>('created_at')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [unreadOnly, setUnreadOnly] = useState(false)

  // Results
  const [rows, setRows] = useState<DialogSearchRow[]>([])
  const [total, setTotal] = useState(0)
  const [limit, setLimit] = useState(0)
  const [selected, setSelected] = useState<Set<string>>(new Set())

  // Delete confirm
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [confirmText, setConfirmText] = useState('')

  const sortedManagers = useMemo(
    () => [...managers].sort((a, b) => a.name.localeCompare(b.name, 'ru')),
    [managers],
  )

  function runSearch() {
    setSearching(true)
    startTransition(async () => {
      try {
        const res = await secretSearchConversationsAction({
          q: q.trim() || undefined,
          searchMessages,
          channelType,
          managerId,
          kind,
          dateField,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
          unreadOnly,
        })
        setRows(res.rows)
        setTotal(res.total)
        setLimit(res.limit)
        setSelected(new Set())
        setHasSearched(true)
        if (res.error) toast.error(res.error)
      } catch {
        toast.error('Не удалось выполнить поиск')
      } finally {
        setSearching(false)
      }
    })
  }

  function resetFilters() {
    setQ('')
    setSearchMessages(false)
    setChannelType('all')
    setManagerId('all')
    setKind('all')
    setDateField('created_at')
    setDateFrom('')
    setDateTo('')
    setUnreadOnly(false)
  }

  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id))

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (rows.every((r) => prev.has(r.id))) return new Set()
      return new Set(rows.map((r) => r.id))
    })
  }

  function invert() {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const r of rows) {
        if (next.has(r.id)) next.delete(r.id)
        else next.add(r.id)
      }
      return next
    })
  }

  function openConfirm() {
    setConfirmText('')
    setConfirmOpen(true)
  }

  function confirmDelete() {
    const ids = [...selected]
    startTransition(async () => {
      try {
        const res = await secretHardDeleteConversationsAction({
          conversationIds: ids,
        })
        if (res.ok) {
          toast.success(res.message)
          const removed = new Set(res.deletedIds ?? ids)
          setRows((prev) => prev.filter((r) => !removed.has(r.id)))
          setTotal((t) => Math.max(0, t - removed.size))
          setSelected(new Set())
          setConfirmOpen(false)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  const selectedCount = selected.size

  return (
    <div className="flex flex-col gap-4">
      {/* Warning banner */}
      <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
        <AlertTriangle className="mt-0.5 size-5 shrink-0 text-destructive" />
        <div className="space-y-1 text-sm">
          <p className="font-medium text-foreground">
            Полное удаление диалога — без возврата
          </p>
          <p className="text-muted-foreground">
            Здесь диалог стирается из системы навсегда: вместе с ним удаляются все
            сообщения, вложения, история передач и данные ИИ. Это не «скрыть» — это
            физическое удаление из базы. Действие необратимо.
          </p>
        </div>
      </Card>

      {/* Filters */}
      <Card className="flex flex-col gap-4 p-4">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) runSearch()
            }}
            placeholder="Имя, @username, телефон, ID диалога, текст превью…"
            className="pl-8"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <Label>Канал</Label>
            <Select
              value={channelType}
              onValueChange={(v) => setChannelType((v as ChannelType | 'all') ?? 'all')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNEL_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Менеджер-владелец</Label>
            <Select value={managerId} onValueChange={(v) => setManagerId(v ?? 'all')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Все менеджеры</SelectItem>
                {sortedManagers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Тип диалога</Label>
            <Select value={kind} onValueChange={(v) => setKind((v as DialogKindFilter) ?? 'all')}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KIND_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Диапазон дат</Label>
            <Select
              value={dateField}
              onValueChange={(v) => setDateField((v as DialogDateField) ?? 'created_at')}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DATE_FIELD_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="date-from">С даты</Label>
            <Input
              id="date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="date-to">По дату</Label>
            <Input
              id="date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={searchMessages} onCheckedChange={setSearchMessages} />
            Искать в тексте сообщений
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <Switch checked={unreadOnly} onCheckedChange={setUnreadOnly} />
            Только с непрочитанными
          </label>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button variant="ghost" onClick={resetFilters} disabled={searching}>
            Сбросить фильтры
          </Button>
          <Button onClick={runSearch} disabled={searching} className="gap-1.5">
            {searching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Search className="size-4" />
            )}
            Найти
          </Button>
        </div>
      </Card>

      {/* Results */}
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-border p-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="text-sm text-muted-foreground">
            {hasSearched ? (
              <>
                Найдено: <span className="font-medium text-foreground">{total}</span>
                {total > rows.length ? ` · показаны первые ${limit}` : ''}
                {selectedCount > 0 ? ` · выбрано ${selectedCount}` : ''}
              </>
            ) : (
              'Задайте критерии и нажмите «Найти».'
            )}
          </div>
          {rows.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              <Button variant="outline" size="sm" onClick={toggleAll} className="gap-1.5">
                <CheckCheck className="size-4" />
                {allSelected ? 'Снять все' : 'Выбрать все'}
              </Button>
              <Button variant="outline" size="sm" onClick={invert} className="gap-1.5">
                <FlipHorizontal2 className="size-4" />
                Инвертировать
              </Button>
              {selectedCount > 0 ? (
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
              <Button
                variant="destructive"
                size="sm"
                onClick={openConfirm}
                disabled={selectedCount === 0 || pending}
                className="gap-1.5"
              >
                <Trash2 className="size-4" />
                Удалить навсегда ({selectedCount})
              </Button>
            </div>
          ) : null}
        </div>

        {!hasSearched ? (
          <div className="p-6">
            <EmptyState
              icon={Search}
              title="Поиск по диалогам"
              description="Поиск охватывает все диалоги системы — по всем менеджерам и каналам."
            />
          </div>
        ) : rows.length === 0 ? (
          <div className="p-6">
            <EmptyState
              icon={Search}
              title="Ничего не найдено"
              description="Измените критерии поиска и попробуйте снова."
            />
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const isSelected = selected.has(r.id)
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => toggle(r.id)}
                    aria-pressed={isSelected}
                    className={cn(
                      'flex w-full items-start gap-3 p-3 text-left transition-colors hover:bg-muted/50',
                      isSelected && 'bg-destructive/5',
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'mt-1 flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors',
                        isSelected
                          ? 'border-destructive bg-destructive text-destructive-foreground'
                          : 'border-input',
                      )}
                    >
                      {isSelected ? <Check className="size-3" /> : null}
                    </span>
                    <ChannelIcon
                      type={r.channelType}
                      className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="truncate font-medium">{r.contactName}</span>
                        {r.contactUsername ? (
                          <span className="truncate text-xs text-muted-foreground">
                            @{r.contactUsername}
                          </span>
                        ) : r.contactHandle ? (
                          <span className="truncate text-xs text-muted-foreground">
                            {r.contactHandle}
                          </span>
                        ) : null}
                        {r.unread > 0 ? (
                          <Badge variant="secondary" className="h-5 px-1.5 text-[0.7rem]">
                            {r.unread} непроч.
                          </Badge>
                        ) : null}
                        {r.godSynthetic ? (
                          <Badge variant="outline" className="h-5 px-1.5 text-[0.7rem]">
                            синтетический
                          </Badge>
                        ) : null}
                        {r.isSimulated ? (
                          <Badge variant="outline" className="h-5 px-1.5 text-[0.7rem]">
                            симуляция
                          </Badge>
                        ) : null}
                      </div>
                      <p className="mt-0.5 truncate text-sm text-muted-foreground">
                        {r.lastMessage || '—'}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                        <span>{r.channelName ?? r.channelType}</span>
                        <span>· {r.managerName ?? 'без владельца'}</span>
                        {r.curatorName ? <span>· куратор: {r.curatorName}</span> : null}
                        <span>· {r.messageCount} сообщ.</span>
                        <span>· создан {fmtDateTime(r.createdAt)}</span>
                        <span>· актив. {fmtDateTime(r.lastMessageAt)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </Card>

      {/* Confirm dialog */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <TriangleAlert className="size-5" />
              Удалить навсегда?
            </DialogTitle>
            <DialogDescription>
              Будет безвозвратно удалено диалогов:{' '}
              <span className="font-semibold text-foreground">{selectedCount}</span>. Вместе
              с ними исчезнут все сообщения, вложения и связанные данные. Отменить это
              действие невозможно.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="confirm-word">
              Введите «{CONFIRM_WORD}», чтобы подтвердить
            </Label>
            <Input
              id="confirm-word"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder={CONFIRM_WORD}
              autoComplete="off"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={pending}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={pending || confirmText.trim() !== CONFIRM_WORD}
              className="gap-1.5"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Удалить навсегда
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
