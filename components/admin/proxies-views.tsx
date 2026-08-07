'use client'

/**
 * Presentational proxy tables (flat list + grouped-by-manager) and their small
 * Metric helper, split out of proxies-admin.tsx. Pure — every mutation goes back
 * to the container through callback props; these components call no server actions.
 */

import { Globe, Loader2, Lock, RefreshCw, Search, ShieldCheck, Trash2, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { useProxyStatusLabels } from '@/components/dictionaries-provider'
import type { Manager, ManagerProxySummary, Proxy } from '@/lib/types'
import {
  UNASSIGNED,
  type AssignFilter,
  type OwnerFilter,
  type SortMode,
  type StatusFilter,
} from '@/components/admin/proxies-shared'

const STATUS_COLOR: Record<Proxy['status'], string> = {
  ok: 'bg-success',
  error: 'bg-destructive',
  unknown: 'bg-muted-foreground',
}

export function AllProxiesView({
  proxies,
  total,
  managers,
  search,
  setSearch,
  statusFilter,
  setStatusFilter,
  ownerFilter,
  setOwnerFilter,
  assignFilter,
  setAssignFilter,
  sortMode,
  setSortMode,
  busyId,
  pending,
  onReassign,
  onCheck,
  onRemove,
}: {
  proxies: Proxy[]
  total: number
  managers: Manager[]
  search: string
  setSearch: (v: string) => void
  statusFilter: StatusFilter
  setStatusFilter: (v: StatusFilter) => void
  ownerFilter: OwnerFilter
  setOwnerFilter: (v: OwnerFilter) => void
  assignFilter: AssignFilter
  setAssignFilter: (v: AssignFilter) => void
  sortMode: SortMode
  setSortMode: (v: SortMode) => void
  busyId: string | null
  pending: boolean
  onReassign: (id: string, value: string) => void
  onCheck: (id: string) => void
  onRemove: (id: string) => void
}) {
  const STATUS_LABEL = useProxyStatusLabels()
  return (
    <div className="flex flex-col gap-4">
      {/* Filters */}
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию, хосту, менеджеру…"
            className="pl-8"
            aria-label="Поиск прокси"
          />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter((v as StatusFilter) ?? 'all')}
          >
            <SelectTrigger aria-label="Статус">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все статусы</SelectItem>
              <SelectItem value="ok">Работают</SelectItem>
              <SelectItem value="error">С ошибкой</SelectItem>
              <SelectItem value="unknown">Не проверены</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={ownerFilter}
            onValueChange={(v) => setOwnerFilter((v as OwnerFilter) ?? 'all')}
          >
            <SelectTrigger aria-label="Владелец">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Любой владелец</SelectItem>
              <SelectItem value="admin">Создан админом</SelectItem>
              <SelectItem value="manager">Создан менеджером</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={assignFilter}
            onValueChange={(v) => setAssignFilter((v as AssignFilter) ?? 'all')}
          >
            <SelectTrigger aria-label="Назначение">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              <SelectItem value="assigned">Назначенные</SelectItem>
              <SelectItem value="unassigned">В пуле</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={sortMode}
            onValueChange={(v) => setSortMode((v as SortMode) ?? 'recent')}
          >
            <SelectTrigger aria-label="Сортировка">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="recent">Сначала новые</SelectItem>
              <SelectItem value="label">По названию</SelectItem>
              <SelectItem value="status">По статусу</SelectItem>
              <SelectItem value="manager">По менеджеру</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Показано {proxies.length} из {total}
      </p>

      {proxies.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          {total === 0
            ? 'Прокси пока нет. Добавьте сервер и назначьте его менеджеру.'
            : 'Ничего не найдено по выбранным фильтрам.'}
        </p>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {proxies.map((p) => {
            const busy = pending && busyId === p.id
            return (
              <Card key={p.id} className="flex flex-col gap-3 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                      <Globe className="size-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="flex items-center gap-1.5 truncate text-sm font-medium">
                        {p.label}
                        {p.hasAuth ? (
                          <Lock className="size-3 text-muted-foreground" />
                        ) : null}
                      </p>
                      <p className="truncate font-mono text-xs text-muted-foreground">
                        {p.kind}://{p.host}:{p.port}
                      </p>
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span
                      className={`size-1.5 rounded-full ${STATUS_COLOR[p.status]}`}
                      aria-hidden="true"
                    />
                    <span className="text-xs text-muted-foreground">
                      {STATUS_LABEL[p.status]}
                    </span>
                  </div>
                </div>

                {/* Ownership chip */}
                <div className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium',
                      p.createdByRole === 'manager'
                        ? 'border-sky-500/20 bg-sky-500/10 text-sky-600 dark:text-sky-400'
                        : 'border-border bg-muted text-muted-foreground',
                    )}
                  >
                    {p.createdByRole === 'manager' ? (
                      <>
                        <User className="size-2.5" />
                        Создан: {p.ownerManagerName ?? 'менеджер'}
                      </>
                    ) : (
                      <>
                        <ShieldCheck className="size-2.5" />
                        Создан админом
                      </>
                    )}
                  </span>
                </div>

                {p.lastError ? (
                  <p className="break-words rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-xs text-destructive">
                    {p.lastError}
                  </p>
                ) : null}

                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Select
                    value={p.managerId ?? UNASSIGNED}
                    onValueChange={(v) => onReassign(p.id, v ?? UNASSIGNED)}
                    disabled={busy}
                  >
                    <SelectTrigger className="w-full sm:flex-1">
                      <SelectValue placeholder="Назначить менеджеру" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED}>В пул (без назначения)</SelectItem>
                      {managers.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onCheck(p.id)}
                      disabled={busy}
                    >
                      {busy ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <RefreshCw className="size-4" />
                      )}
                      Тест
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Удалить ${p.label}`}
                      onClick={() => onRemove(p.id)}
                      disabled={busy}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function ByManagerView({ summaries }: { summaries: ManagerProxySummary[] }) {
  if (summaries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
        Менеджеров пока нет.
      </p>
    )
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {summaries.map((s) => (
        <Card key={s.manager.id} className="flex flex-col gap-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2.5">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-muted/40 text-xs font-medium">
                {s.manager.name.slice(0, 2).toUpperCase()}
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{s.manager.name}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {s.manager.email}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 flex-col items-end">
              <span className="text-lg font-semibold tabular-nums">{s.total}</span>
              <span className="text-[10px] text-muted-foreground">прокси</span>
            </div>
          </div>

          {/* Status bar */}
          {s.total > 0 ? (
            <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
              <span
                className="bg-success"
                style={{ width: `${(s.ok / s.total) * 100}%` }}
              />
              <span
                className="bg-destructive"
                style={{ width: `${(s.error / s.total) * 100}%` }}
              />
              <span
                className="bg-muted-foreground"
                style={{ width: `${(s.unknown / s.total) * 100}%` }}
              />
            </div>
          ) : (
            <div className="h-1.5 rounded-full bg-muted" />
          )}

          <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
            <Metric label="Работают" value={s.ok} tone="success" />
            <Metric label="Ошибки" value={s.error} tone="error" />
            <Metric label="Свои" value={s.selfOwned} />
            <Metric label="Каналов" value={s.channelsRouted} />
          </div>

          <p className="text-[11px] text-muted-foreground">
            {s.adminAssigned} назначено админом · {s.selfOwned} создано
            менеджером
          </p>
        </Card>
      ))}
    </div>
  )
}

function Metric({
  label,
  value,
  tone = 'default',
}: {
  label: string
  value: number
  tone?: 'default' | 'success' | 'error'
}) {
  const toneClass =
    tone === 'success'
      ? 'text-success'
      : tone === 'error'
        ? 'text-destructive'
        : 'text-foreground'
  return (
    <div className="rounded-md border border-border bg-muted/20 px-2 py-1.5">
      <p className={cn('text-sm font-semibold tabular-nums', toneClass)}>
        {value}
      </p>
      <p className="text-[10px] text-muted-foreground">{label}</p>
    </div>
  )
}
