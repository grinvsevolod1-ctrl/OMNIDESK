'use client'

import { useMemo, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  ArrowDownLeft,
  ArrowUpRight,
  Check,
  Clock,
  Loader2,
  MessagesSquare,
  RefreshCw,
  Search,
  TriangleAlert,
  UserRound,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import {
  simAdoptConversationsAction,
  simListAdoptableAction,
} from '@/app/actions/client-sim'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { ChannelType } from '@/lib/types'
import type { AdoptableConversation } from '@/lib/client-sim/store'

const MIN_SPREAD = 1
const MAX_SPREAD = 165

/** "5 мин назад" / "3 ч назад" / "12 янв". */
function relTime(iso: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  const diff = Date.now() - then
  const m = Math.round(diff / 60_000)
  if (m < 1) return 'только что'
  if (m < 60) return `${m} мин назад`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} ч назад`
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

interface ManagerGroup {
  managerId: string
  managerName: string
  rows: AdoptableConversation[]
}

export function SecretSimulatorAdopt() {
  const [pending, startTransition] = useTransition()
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [queryText, setQueryText] = useState('')
  const [spread, setSpread] = useState(120)

  const {
    data: rows = [],
    error,
    isLoading,
    mutate,
  } = useSWR<AdoptableConversation[]>(
    'sim-adoptable',
    () => simListAdoptableAction(),
    { revalidateOnFocus: false },
  )

  // Group by manager, applying the text filter first.
  const groups = useMemo<ManagerGroup[]>(() => {
    const q = queryText.trim().toLowerCase()
    const filtered = q
      ? rows.filter(
          (r) =>
            r.contactName.toLowerCase().includes(q) ||
            (r.lastMessage ?? '').toLowerCase().includes(q) ||
            (r.managerName ?? '').toLowerCase().includes(q),
        )
      : rows
    const byManager = new Map<string, ManagerGroup>()
    for (const r of filtered) {
      const key = r.managerId ?? 'none'
      let g = byManager.get(key)
      if (!g) {
        g = {
          managerId: key,
          managerName: r.managerName ?? 'Без менеджера',
          rows: [],
        }
        byManager.set(key, g)
      }
      g.rows.push(r)
    }
    return [...byManager.values()].sort((a, b) =>
      a.managerName.localeCompare(b.managerName, 'ru'),
    )
  }, [rows, queryText])

  const selectableIds = useMemo(
    () => rows.filter((r) => !r.adopted).map((r) => r.id),
    [rows],
  )
  const adoptedCount = rows.length - selectableIds.length

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleGroup(g: ManagerGroup) {
    const ids = g.rows.filter((r) => !r.adopted).map((r) => r.id)
    const allOn = ids.length > 0 && ids.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allOn) ids.forEach((id) => next.delete(id))
      else ids.forEach((id) => next.add(id))
      return next
    })
  }

  function selectAll() {
    setSelected(new Set(selectableIds))
  }
  function clearAll() {
    setSelected(new Set())
  }

  function save() {
    const ids = Array.from(selected)
    if (ids.length === 0) return
    const spreadMinutes = Math.min(Math.max(Math.round(spread) || MIN_SPREAD, MIN_SPREAD), MAX_SPREAD)
    startTransition(async () => {
      try {
        const res = await simAdoptConversationsAction({
          conversationIds: ids,
          spreadMinutes,
        })
        toast.success(
          `Симулятор продолжит ${res.adopted} диалог(ов)` +
            (res.skipped > 0 ? `, пропущено ${res.skipped}` : ''),
        )
        clearAll()
        void mutate()
      } catch {
        toast.error('Не удалось подключить диалоги к симулятору')
      }
    })
  }

  const selCount = selected.size

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
          <MessagesSquare className="size-4 text-foreground" />
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold tracking-tight">Продолжить существующие диалоги</h3>
          <p className="max-w-prose text-sm text-muted-foreground text-pretty">
            По умолчанию симулятор ведёт только новые диалоги, которые создал сам.
            Отметьте здесь любые существующие переписки — и после сохранения он
            подхватит их и продолжит от лица того же клиента, вразнобой по времени.
          </p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Поиск по имени, тексту или менеджеру"
            className="h-9 pl-8"
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void mutate()}
          disabled={isLoading}
        >
          {isLoading ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Обновить
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <button
          type="button"
          className="text-foreground/70 underline-offset-2 hover:underline"
          onClick={selectAll}
        >
          Выбрать все ({selectableIds.length})
        </button>
        <span className="text-muted-foreground">·</span>
        <button
          type="button"
          className="text-foreground/70 underline-offset-2 hover:underline"
          onClick={clearAll}
        >
          Сбросить
        </button>
        {adoptedCount > 0 && (
          <span className="text-muted-foreground">
            уже в симуляторе: {adoptedCount}
          </span>
        )}
      </div>

      {/* List */}
      {error ? (
        <div className="flex items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
          <TriangleAlert className="size-4 shrink-0" />
          Не удалось загрузить список диалогов.
        </div>
      ) : isLoading ? (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Загрузка диалогов…
        </div>
      ) : rows.length === 0 ? (
        <p className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
          Нет диалогов с назначенным менеджером. Как только появятся входящие
          переписки, они отобразятся здесь.
        </p>
      ) : (
        <div className="flex max-h-[28rem] flex-col gap-4 overflow-y-auto pr-1">
          {groups.map((g) => {
            const groupSelectable = g.rows.filter((r) => !r.adopted)
            const allOn =
              groupSelectable.length > 0 &&
              groupSelectable.every((r) => selected.has(r.id))
            const someOn = groupSelectable.some((r) => selected.has(r.id))
            return (
              <div key={g.managerId} className="flex flex-col gap-1.5">
                <div className="sticky top-0 z-10 flex items-center gap-2 bg-card/95 py-1 backdrop-blur">
                  <button
                    type="button"
                    role="checkbox"
                    aria-checked={someOn && !allOn ? 'mixed' : allOn}
                    aria-label={`Выбрать все диалоги: ${g.managerName}`}
                    disabled={groupSelectable.length === 0}
                    onClick={() => toggleGroup(g)}
                    className={cn(
                      'shrink-0',
                      groupSelectable.length === 0
                        ? 'cursor-not-allowed'
                        : 'hover:opacity-80',
                    )}
                  >
                    <CheckMark
                      checked={allOn}
                      partial={someOn && !allOn}
                      disabled={groupSelectable.length === 0}
                    />
                  </button>
                  <UserRound className="size-4 text-muted-foreground" />
                  <span className="text-sm font-semibold">{g.managerName}</span>
                  <Badge variant="secondary" className="ml-auto tabular-nums">
                    {g.rows.length}
                  </Badge>
                </div>
                <div className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border">
                  {g.rows.map((r) => (
                    <ConversationRow
                      key={r.id}
                      row={r}
                      checked={selected.has(r.id)}
                      onToggle={() => toggle(r.id)}
                    />
                  ))}
                </div>
              </div>
            )
          })}
          {groups.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Ничего не найдено по запросу.
            </p>
          )}
        </div>
      )}

      {/* Footer: spread + save */}
      <div className="flex flex-wrap items-end justify-between gap-4 border-t border-border pt-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sim-spread" className="flex items-center gap-1.5">
            <Clock className="size-3.5 text-muted-foreground" />
            Разброс во времени, мин
          </Label>
          <Input
            id="sim-spread"
            type="number"
            inputMode="numeric"
            min={MIN_SPREAD}
            max={MAX_SPREAD}
            value={spread}
            onChange={(e) => setSpread(Number(e.target.value))}
            onBlur={() =>
              setSpread((v) =>
                Math.min(Math.max(Math.round(v) || MIN_SPREAD, MIN_SPREAD), MAX_SPREAD),
              )
            }
            className="h-9 w-28 tabular-nums"
          />
          <p className="max-w-xs text-[11px] text-muted-foreground text-pretty">
            За сколько минут случайно «размазать» возобновление выбранных диалогов,
            чтобы они ожили не разом, а вразнобой.
          </p>
        </div>
        <Button
          size="lg"
          className="press-scale gap-2"
          onClick={save}
          disabled={pending || selCount === 0}
        >
          {pending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Check className="size-4" />
          )}
          Продолжить выбранные{selCount > 0 ? ` (${selCount})` : ''}
        </Button>
      </div>
    </Card>
  )
}

/* ------------------------------- pieces --------------------------------- */

/**
 * Visual-only checkbox. Rendered as a <span> so it can live inside a clickable
 * row <button> without nesting interactive elements. The parent handles clicks.
 */
function CheckMark({
  checked,
  partial,
  disabled,
}: {
  checked: boolean
  partial?: boolean
  disabled?: boolean
}) {
  return (
    <span
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
        disabled
          ? 'border-border bg-muted/50 opacity-50'
          : checked || partial
            ? 'border-foreground bg-foreground text-background'
            : 'border-border bg-background',
      )}
    >
      {checked ? (
        <Check className="size-3" />
      ) : partial ? (
        <span className="size-1.5 rounded-sm bg-background" />
      ) : null}
    </span>
  )
}

function ConversationRow({
  row,
  checked,
  onToggle,
}: {
  row: AdoptableConversation
  checked: boolean
  onToggle: () => void
}) {
  const disabled = row.adopted
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onToggle}
      role="checkbox"
      aria-checked={checked}
      className={cn(
        'flex items-center gap-2.5 px-3 py-2 text-left transition-colors',
        disabled ? 'cursor-not-allowed bg-muted/30' : 'hover:bg-muted/50',
      )}
    >
      <CheckMark checked={checked} disabled={disabled} />
      <ChannelIcon type={row.channelType as ChannelType} className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{row.contactName}</span>
          {row.adopted && (
            <Badge variant="secondary" className="shrink-0 text-[10px]">
              в симуляторе
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {row.lastMessage ?? 'нет сообщений'}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-1">
        <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {row.lastDirection === 'out' ? (
            <ArrowUpRight className="size-3 text-primary" />
          ) : row.lastDirection === 'in' ? (
            <ArrowDownLeft className="size-3 text-success" />
          ) : null}
          {relTime(row.lastMessageAt)}
        </span>
        <span className="text-[11px] tabular-nums text-muted-foreground">
          {row.messageCount} сообщ.
        </span>
      </div>
    </button>
  )
}
