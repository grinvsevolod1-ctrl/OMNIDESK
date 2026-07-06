'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  ChevronRight,
  Coins,
  FolderPlus,
  ListChecks,
  Loader2,
  Pencil,
  Plus,
  Scale,
  Search,
  Trash2,
  TrendingDown,
  TrendingUp,
  Wallet,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  addTaskAction,
  createEntryAction,
  createResourceAction,
  createSectionAction,
  deleteEntryAction,
  deleteResourceAction,
  deleteSectionAction,
  deleteTaskAction,
  renameSectionAction,
  toggleTaskAction,
  updateEntryAction,
  updateResourceAction,
  type FinanceResult,
} from '@/app/actions/finance'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
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
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import type {
  FinanceCurrency,
  FinanceEntry,
  FinanceEntryStatus,
  FinanceEntryType,
  FinanceResource,
  FinanceSection,
} from '@/lib/finance'

/* ------------------------------------------------------------------ */
/* Meta                                                                */
/* ------------------------------------------------------------------ */

const STATUS_META: Record<
  FinanceEntryStatus,
  { label: string; className: string }
> = {
  planned: {
    label: 'Запланировано',
    className: 'bg-muted text-muted-foreground',
  },
  in_progress: { label: 'В работе', className: 'bg-warning/15 text-warning' },
  done: { label: 'Выполнено', className: 'bg-success/15 text-success' },
  cancelled: {
    label: 'Отменено',
    className: 'bg-destructive/10 text-destructive',
  },
}

const TYPE_META: Record<
  FinanceEntryType,
  { label: string; className: string; sign: string }
> = {
  income: {
    label: 'Доход',
    className: 'bg-success/15 text-success',
    sign: '+',
  },
  expense: {
    label: 'Расход',
    className: 'bg-destructive/10 text-destructive',
    sign: '−',
  },
}

const CURRENCY_LABEL: Record<FinanceCurrency, string> = {
  USDT: 'USDT',
  RUB: '₽',
}

function formatMoney(amount: number, currency: FinanceCurrency): string {
  const n = new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.abs(amount))
  return currency === 'RUB' ? `${n} ₽` : `${n} USDT`
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}

function formatDate(iso: string): string {
  const d = new Date(iso + 'T00:00:00')
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(d)
}

interface Totals {
  income: number
  expense: number
  balance: number
  count: number
}

function computeTotals(entries: FinanceEntry[]): Totals {
  let income = 0
  let expense = 0
  for (const e of entries) {
    if (e.status === 'cancelled') continue
    if (e.type === 'income') income += e.amount
    else expense += e.amount
  }
  return { income, expense, balance: income - expense, count: entries.length }
}

type SortField = 'date' | 'title' | 'amount' | 'status'
type SortDir = 'asc' | 'desc'
type TypeFilter = 'all' | FinanceEntryType
type StatusFilter = 'all' | FinanceEntryStatus

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

export function FinanceAdmin({
  resources,
  sections,
  entries,
}: {
  resources: FinanceResource[]
  sections: FinanceSection[]
  entries: FinanceEntry[]
}) {
  const [pending, startTransition] = useTransition()
  const [resourceId, setResourceId] = useState<string | null>(null)
  const [sectionId, setSectionId] = useState<string | null>(null)

  // Dialog state
  const [resourceDialog, setResourceDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; resource: FinanceResource } | null
  >(null)
  const [entryDialog, setEntryDialog] = useState<
    | { mode: 'create'; sectionId: string }
    | { mode: 'edit'; entry: FinanceEntry }
    | null
  >(null)
  const [confirm, setConfirm] = useState<{
    title: string
    description: string
    onConfirm: () => void
  } | null>(null)

  // Table controls
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  function run(fn: () => Promise<FinanceResult>, onOk?: () => void) {
    startTransition(async () => {
      const res = await fn()
      if (res.ok) {
        toast.success(res.message)
        onOk?.()
      } else {
        toast.error(res.message)
      }
    })
  }

  // Derived active resource/section with graceful fallback after deletions.
  const activeResource =
    resources.find((r) => r.id === resourceId) ?? resources[0] ?? null
  const resourceSections = useMemo(
    () =>
      activeResource
        ? sections.filter((s) => s.resourceId === activeResource.id)
        : [],
    [sections, activeResource],
  )
  const activeSection =
    resourceSections.find((s) => s.id === sectionId) ??
    resourceSections[0] ??
    null

  const resourceEntries = useMemo(
    () =>
      activeResource
        ? entries.filter((e) => e.resourceId === activeResource.id)
        : [],
    [entries, activeResource],
  )
  const sectionEntries = useMemo(
    () =>
      activeSection
        ? resourceEntries.filter((e) => e.sectionId === activeSection.id)
        : [],
    [resourceEntries, activeSection],
  )

  const currency: FinanceCurrency = activeResource?.currency ?? 'USDT'
  const resourceTotals = useMemo(
    () => computeTotals(resourceEntries),
    [resourceEntries],
  )
  const sectionTotals = useMemo(
    () => computeTotals(sectionEntries),
    [sectionEntries],
  )

  // Filter + sort for the visible table.
  const visibleEntries = useMemo(() => {
    const q = search.trim().toLowerCase()
    const filtered = sectionEntries.filter((e) => {
      if (typeFilter !== 'all' && e.type !== typeFilter) return false
      if (statusFilter !== 'all' && e.status !== statusFilter) return false
      if (q) {
        const hay = (e.title + ' ' + e.notes).toLowerCase()
        if (!hay.includes(q)) return false
      }
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    const order: Record<FinanceEntryStatus, number> = {
      planned: 0,
      in_progress: 1,
      done: 2,
      cancelled: 3,
    }
    return [...filtered].sort((a, b) => {
      switch (sortField) {
        case 'title':
          return a.title.localeCompare(b.title, 'ru') * dir
        case 'amount':
          return (a.amount - b.amount) * dir
        case 'status':
          return (order[a.status] - order[b.status]) * dir
        case 'date':
        default: {
          const d = a.entryDate.localeCompare(b.entryDate)
          return (d !== 0 ? d : a.createdAt.localeCompare(b.createdAt)) * dir
        }
      }
    })
  }, [sectionEntries, search, typeFilter, statusFilter, sortField, sortDir])

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'title' ? 'asc' : 'desc')
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /* ----------------------------- empty ----------------------------- */
  if (resources.length === 0) {
    return (
      <>
        <EmptyState
          icon={Wallet}
          title="Пока нет ресурсов"
          description="Добавьте первый ресурс (например, site.com), затем создайте внутри него вкладки и записи доходов и расходов."
          action={
            <Button onClick={() => setResourceDialog({ mode: 'create' })}>
              <Plus className="size-4" />
              Добавить ресурс
            </Button>
          }
        />
        <ResourceDialog
          state={resourceDialog}
          pending={pending}
          onClose={() => setResourceDialog(null)}
          onSubmit={(fd, state) =>
            run(
              () =>
                state.mode === 'create'
                  ? createResourceAction(fd)
                  : updateResourceAction(state.resource.id, fd),
              () => setResourceDialog(null),
            )
          }
        />
      </>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Resource selector */}
      <div className="flex flex-wrap items-center gap-2">
        {resources.map((r) => {
          const active = activeResource?.id === r.id
          return (
            <button
              key={r.id}
              type="button"
              onClick={() => {
                setResourceId(r.id)
                setSectionId(null)
              }}
              className={cn(
                'group inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                r.archived && 'opacity-60',
              )}
            >
              <Wallet className="size-3.5" />
              {r.name}
              <Badge variant="outline" className="ml-1">
                {CURRENCY_LABEL[r.currency]}
              </Badge>
              {r.archived ? (
                <Badge variant="ghost" className="text-muted-foreground">
                  архив
                </Badge>
              ) : null}
            </button>
          )
        })}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setResourceDialog({ mode: 'create' })}
        >
          <Plus className="size-4" />
          Ресурс
        </Button>
      </div>

      {activeResource ? (
        <>
          {/* Resource header + actions */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-1">
              <h2 className="text-lg font-semibold tracking-tight">
                {activeResource.name}
              </h2>
              {activeResource.description ? (
                <p className="max-w-xl text-sm text-muted-foreground">
                  {activeResource.description}
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setResourceDialog({ mode: 'edit', resource: activeResource })
                }
              >
                <Pencil className="size-3.5" />
                Изменить
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => {
                  const fd = new FormData()
                  fd.set('name', activeResource.name)
                  fd.set('description', activeResource.description)
                  fd.set('currency', activeResource.currency)
                  fd.set('archived', String(!activeResource.archived))
                  run(() => updateResourceAction(activeResource.id, fd))
                }}
              >
                {activeResource.archived ? (
                  <>
                    <ArchiveRestore className="size-3.5" />
                    Из архива
                  </>
                ) : (
                  <>
                    <Archive className="size-3.5" />
                    В архив
                  </>
                )}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() =>
                  setConfirm({
                    title: `Удалить ресурс «${activeResource.name}»?`,
                    description:
                      'Будут удалены все вкладки, записи и чек-листы этого ресурса. Действие необратимо.',
                    onConfirm: () =>
                      run(
                        () => deleteResourceAction(activeResource.id),
                        () => setResourceId(null),
                      ),
                  })
                }
              >
                <Trash2 className="size-3.5" />
                Удалить
              </Button>
            </div>
          </div>

          {/* Resource summary */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryCard
              label="Доходы"
              value={formatMoney(resourceTotals.income, currency)}
              icon={TrendingUp}
              tone="success"
            />
            <SummaryCard
              label="Расходы"
              value={formatMoney(resourceTotals.expense, currency)}
              icon={TrendingDown}
              tone="destructive"
            />
            <SummaryCard
              label="Баланс"
              value={
                (resourceTotals.balance < 0 ? '−' : '') +
                formatMoney(resourceTotals.balance, currency)
              }
              icon={Scale}
              tone={resourceTotals.balance < 0 ? 'destructive' : 'default'}
            />
            <SummaryCard
              label="Записей"
              value={String(resourceTotals.count)}
              icon={Coins}
              tone="default"
            />
          </div>

          {/* Section tabs */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border pb-2">
            {resourceSections.map((s) => {
              const active = activeSection?.id === s.id
              return (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => setSectionId(s.id)}
                  className={cn(
                    'rounded-lg px-3 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? 'bg-secondary text-secondary-foreground'
                      : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {s.name}
                </button>
              )
            })}
            <AddSectionButton
              pending={pending}
              onAdd={(name) =>
                run(() => createSectionAction(activeResource.id, name))
              }
            />
          </div>

          {/* Section content */}
          {activeSection ? (
            <div className="flex flex-col gap-4">
              {/* Section toolbar */}
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-semibold">
                      {activeSection.name}
                    </h3>
                    <RenameSectionButton
                      current={activeSection.name}
                      pending={pending}
                      onRename={(name) =>
                        run(() =>
                          renameSectionAction(activeSection.id, name),
                        )
                      }
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Удалить вкладку"
                      onClick={() =>
                        setConfirm({
                          title: `Удалить вкладку «${activeSection.name}»?`,
                          description:
                            'Все записи и чек-листы этой вкладки будут удалены безвозвратно.',
                          onConfirm: () =>
                            run(
                              () => deleteSectionAction(activeSection.id),
                              () => setSectionId(null),
                            ),
                        })
                      }
                    >
                      <Trash2 className="size-3.5 text-destructive" />
                    </Button>
                  </div>
                  <Button
                    size="sm"
                    onClick={() =>
                      setEntryDialog({
                        mode: 'create',
                        sectionId: activeSection.id,
                      })
                    }
                  >
                    <Plus className="size-4" />
                    Запись
                  </Button>
                </div>

                {/* Section mini-summary */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span>
                    Доход:{' '}
                    <span className="font-medium text-success">
                      {formatMoney(sectionTotals.income, currency)}
                    </span>
                  </span>
                  <span>
                    Расход:{' '}
                    <span className="font-medium text-destructive">
                      {formatMoney(sectionTotals.expense, currency)}
                    </span>
                  </span>
                  <span>
                    Баланс:{' '}
                    <span
                      className={cn(
                        'font-medium',
                        sectionTotals.balance < 0
                          ? 'text-destructive'
                          : 'text-foreground',
                      )}
                    >
                      {(sectionTotals.balance < 0 ? '−' : '') +
                        formatMoney(sectionTotals.balance, currency)}
                    </span>
                  </span>
                </div>

                {/* Filters */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Поиск по названию или заметкам"
                      className="pl-8"
                    />
                  </div>
                  <Select
                    value={typeFilter}
                    onValueChange={(v) => setTypeFilter(v as TypeFilter)}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все типы</SelectItem>
                      <SelectItem value="income">Доход</SelectItem>
                      <SelectItem value="expense">Расход</SelectItem>
                    </SelectContent>
                  </Select>
                  <Select
                    value={statusFilter}
                    onValueChange={(v) => setStatusFilter(v as StatusFilter)}
                  >
                    <SelectTrigger size="sm">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Все статусы</SelectItem>
                      <SelectItem value="planned">Запланировано</SelectItem>
                      <SelectItem value="in_progress">В работе</SelectItem>
                      <SelectItem value="done">Выполнено</SelectItem>
                      <SelectItem value="cancelled">Отменено</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Entries table */}
              {sectionEntries.length === 0 ? (
                <EmptyState
                  icon={Coins}
                  title="Нет записей"
                  description="Добавьте первую запись дохода или расхода в этой вкладке."
                  action={
                    <Button
                      size="sm"
                      onClick={() =>
                        setEntryDialog({
                          mode: 'create',
                          sectionId: activeSection.id,
                        })
                      }
                    >
                      <Plus className="size-4" />
                      Запись
                    </Button>
                  }
                />
              ) : visibleEntries.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
                  Ничего не найдено по текущим фильтрам.
                </p>
              ) : (
                <Card className="overflow-hidden p-0">
                  <div className="w-full overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                        <tr>
                          <th className="w-8 p-2" />
                          <SortHeader
                            label="Дата"
                            field="date"
                            sortField={sortField}
                            sortDir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="Название"
                            field="title"
                            sortField={sortField}
                            sortDir={sortDir}
                            onSort={toggleSort}
                          />
                          <th className="p-2 text-left font-medium">Тип</th>
                          <SortHeader
                            label="Статус"
                            field="status"
                            sortField={sortField}
                            sortDir={sortDir}
                            onSort={toggleSort}
                          />
                          <SortHeader
                            label="Сумма"
                            field="amount"
                            sortField={sortField}
                            sortDir={sortDir}
                            onSort={toggleSort}
                            className="text-right"
                          />
                          <th className="p-2 text-left font-medium">Задачи</th>
                          <th className="w-20 p-2" />
                        </tr>
                      </thead>
                      <tbody>
                        {visibleEntries.map((entry) => (
                          <EntryRow
                            key={entry.id}
                            entry={entry}
                            currency={currency}
                            expanded={expanded.has(entry.id)}
                            pending={pending}
                            onToggle={() => toggleExpanded(entry.id)}
                            onEdit={() =>
                              setEntryDialog({ mode: 'edit', entry })
                            }
                            onDelete={() =>
                              setConfirm({
                                title: `Удалить запись «${entry.title}»?`,
                                description:
                                  'Запись и её чек-лист будут удалены.',
                                onConfirm: () =>
                                  run(() => deleteEntryAction(entry.id)),
                              })
                            }
                            onAddTask={(label) =>
                              run(() => addTaskAction(entry.id, label))
                            }
                            onToggleTask={(taskId, done) =>
                              run(() => toggleTaskAction(taskId, done))
                            }
                            onDeleteTask={(taskId) =>
                              run(() => deleteTaskAction(taskId))
                            }
                          />
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </div>
          ) : (
            <EmptyState
              icon={FolderPlus}
              title="Нет вкладок"
              description="Создайте первую вкладку (например, «Материалы» или «Реклама»), чтобы добавлять в неё записи."
              action={
                <AddSectionButton
                  pending={pending}
                  onAdd={(name) =>
                    run(() => createSectionAction(activeResource.id, name))
                  }
                  variant="button"
                />
              }
            />
          )}
        </>
      ) : null}

      {/* Dialogs */}
      <ResourceDialog
        state={resourceDialog}
        pending={pending}
        onClose={() => setResourceDialog(null)}
        onSubmit={(fd, state) =>
          run(
            () =>
              state.mode === 'create'
                ? createResourceAction(fd)
                : updateResourceAction(state.resource.id, fd),
            () => setResourceDialog(null),
          )
        }
      />

      <EntryDialog
        state={entryDialog}
        pending={pending}
        onClose={() => setEntryDialog(null)}
        onSubmit={(fd, state) =>
          run(
            () =>
              state.mode === 'create'
                ? createEntryAction(state.sectionId, fd)
                : updateEntryAction(state.entry.id, fd),
            () => setEntryDialog(null),
          )
        }
      />

      <Dialog
        open={!!confirm}
        onOpenChange={(o) => {
          if (!o) setConfirm(null)
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{confirm?.title}</DialogTitle>
            <DialogDescription>{confirm?.description}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose
              render={<Button variant="outline">Отмена</Button>}
            />
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => {
                confirm?.onConfirm()
                setConfirm(null)
              }}
            >
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Удалить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Summary card                                                        */
/* ------------------------------------------------------------------ */

function SummaryCard({
  label,
  value,
  icon: Icon,
  tone,
}: {
  label: string
  value: string
  icon: typeof Wallet
  tone: 'success' | 'destructive' | 'default'
}) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <Icon
          className={cn(
            'size-4',
            tone === 'success' && 'text-success',
            tone === 'destructive' && 'text-destructive',
            tone === 'default' && 'text-muted-foreground',
          )}
        />
      </div>
      <div
        className={cn(
          'mt-3 text-xl font-semibold tracking-tight tabular-nums',
          tone === 'success' && 'text-success',
          tone === 'destructive' && 'text-destructive',
        )}
      >
        {value}
      </div>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Sort header                                                         */
/* ------------------------------------------------------------------ */

function SortHeader({
  label,
  field,
  sortField,
  sortDir,
  onSort,
  className,
}: {
  label: string
  field: SortField
  sortField: SortField
  sortDir: SortDir
  onSort: (f: SortField) => void
  className?: string
}) {
  const active = sortField === field
  return (
    <th className={cn('p-2 text-left font-medium', className)}>
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'inline-flex items-center gap-1 transition-colors hover:text-foreground',
          className?.includes('text-right') && 'flex-row-reverse',
          active && 'text-foreground',
        )}
      >
        {label}
        {active ? (
          sortDir === 'asc' ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-40" />
        )}
      </button>
    </th>
  )
}

/* ------------------------------------------------------------------ */
/* Entry row + checklist                                               */
/* ------------------------------------------------------------------ */

function EntryRow({
  entry,
  currency,
  expanded,
  pending,
  onToggle,
  onEdit,
  onDelete,
  onAddTask,
  onToggleTask,
  onDeleteTask,
}: {
  entry: FinanceEntry
  currency: FinanceCurrency
  expanded: boolean
  pending: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  onAddTask: (label: string) => void
  onToggleTask: (taskId: string, done: boolean) => void
  onDeleteTask: (taskId: string) => void
}) {
  const [newTask, setNewTask] = useState('')
  const doneCount = entry.tasks.filter((t) => t.done).length
  const type = TYPE_META[entry.type]
  const status = STATUS_META[entry.status]

  function submitTask() {
    const v = newTask.trim()
    if (!v) return
    onAddTask(v)
    setNewTask('')
  }

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-muted/40">
        <td className="p-2 align-top">
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={expanded}
            aria-label={expanded ? 'Свернуть' : 'Развернуть'}
            className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        </td>
        <td className="whitespace-nowrap p-2 align-top text-muted-foreground">
          {formatDate(entry.entryDate)}
        </td>
        <td className="p-2 align-top font-medium">{entry.title}</td>
        <td className="p-2 align-top">
          <Badge className={cn('font-medium', type.className)} variant="outline">
            {type.label}
          </Badge>
        </td>
        <td className="p-2 align-top">
          <Badge
            className={cn('font-medium', status.className)}
            variant="outline"
          >
            {status.label}
          </Badge>
        </td>
        <td
          className={cn(
            'whitespace-nowrap p-2 text-right align-top font-medium tabular-nums',
            entry.status === 'cancelled'
              ? 'text-muted-foreground line-through'
              : entry.type === 'income'
                ? 'text-success'
                : 'text-destructive',
          )}
        >
          {type.sign}
          {formatMoney(entry.amount, currency)}
        </td>
        <td className="p-2 align-top">
          {entry.tasks.length > 0 ? (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <ListChecks className="size-3.5" />
              {doneCount}/{entry.tasks.length}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground">—</span>
          )}
        </td>
        <td className="p-2 align-top">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Изменить запись"
              onClick={onEdit}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Удалить запись"
              onClick={onDelete}
            >
              <Trash2 className="size-3.5 text-destructive" />
            </Button>
          </div>
        </td>
      </tr>
      {expanded ? (
        <tr className="border-b border-border bg-muted/20 last:border-0">
          <td />
          <td colSpan={7} className="p-4">
            <div className="flex flex-col gap-4 lg:flex-row">
              {/* Notes */}
              <div className="flex-1 space-y-1">
                <p className="text-xs font-medium text-muted-foreground">
                  Заметки / ответы
                </p>
                {entry.notes ? (
                  <p className="whitespace-pre-wrap text-sm leading-relaxed">
                    {entry.notes}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Нет заметок.
                  </p>
                )}
              </div>

              {/* Checklist */}
              <div className="flex-1 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs font-medium text-muted-foreground">
                    Пункты выполненных задач ({doneCount}/{entry.tasks.length})
                  </p>
                </div>
                {entry.tasks.length > 0 ? (
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-success transition-all"
                      style={{
                        width: `${
                          entry.tasks.length
                            ? (doneCount / entry.tasks.length) * 100
                            : 0
                        }%`,
                      }}
                    />
                  </div>
                ) : null}
                <ul className="flex flex-col gap-1">
                  {entry.tasks.map((task) => (
                    <li
                      key={task.id}
                      className="group flex items-center gap-2 rounded-md px-1.5 py-1 hover:bg-muted/60"
                    >
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={task.done}
                        disabled={pending}
                        onClick={() => onToggleTask(task.id, !task.done)}
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border transition-colors',
                          task.done
                            ? 'border-success bg-success text-success-foreground'
                            : 'border-input hover:border-foreground',
                        )}
                      >
                        {task.done ? <Check className="size-3" /> : null}
                      </button>
                      <span
                        className={cn(
                          'flex-1 text-sm',
                          task.done &&
                            'text-muted-foreground line-through',
                        )}
                      >
                        {task.label}
                      </span>
                      <button
                        type="button"
                        aria-label="Удалить пункт"
                        disabled={pending}
                        onClick={() => onDeleteTask(task.id)}
                        className="text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex items-center gap-2">
                  <Input
                    value={newTask}
                    onChange={(e) => setNewTask(e.target.value)}
                    onKeyDown={(e) => {
                      if (
                        e.key === 'Enter' &&
                        !e.nativeEvent.isComposing &&
                        e.keyCode !== 229
                      ) {
                        e.preventDefault()
                        submitTask()
                      }
                    }}
                    placeholder="Новый пункт…"
                    className="h-8"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending || !newTask.trim()}
                    onClick={submitTask}
                  >
                    <Plus className="size-4" />
                  </Button>
                </div>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

/* ------------------------------------------------------------------ */
/* Add / rename section                                                */
/* ------------------------------------------------------------------ */

function AddSectionButton({
  pending,
  onAdd,
  variant = 'inline',
}: {
  pending: boolean
  onAdd: (name: string) => void
  variant?: 'inline' | 'button'
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')

  function submit() {
    const v = name.trim()
    if (!v) return
    onAdd(v)
    setName('')
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        variant={variant === 'button' ? 'default' : 'ghost'}
        size="sm"
        onClick={() => setOpen(true)}
      >
        <FolderPlus className="size-4" />
        Вкладка
      </Button>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Новая вкладка</DialogTitle>
          <DialogDescription>
            Например: «Материалы», «Реклама», «Хостинг».
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="section-name">Название</Label>
          <Input
            id="section-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                submit()
              }
            }}
            placeholder="Название вкладки"
            autoFocus
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Отмена</Button>} />
          <Button disabled={pending || !name.trim()} onClick={submit}>
            Добавить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function RenameSectionButton({
  current,
  pending,
  onRename,
}: {
  current: string
  pending: boolean
  onRename: (name: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(current)

  function submit() {
    const v = name.trim()
    if (!v) return
    onRename(v)
    setOpen(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setName(current)
      }}
    >
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="Переименовать вкладку"
        onClick={() => setOpen(true)}
      >
        <Pencil className="size-3.5" />
      </Button>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Переименовать вкладку</DialogTitle>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="rename-section">Название</Label>
          <Input
            id="rename-section"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                submit()
              }
            }}
            autoFocus
          />
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Отмена</Button>} />
          <Button disabled={pending || !name.trim()} onClick={submit}>
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Resource dialog                                                     */
/* ------------------------------------------------------------------ */

type ResourceDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; resource: FinanceResource }
  | null

function ResourceDialog({
  state,
  pending,
  onClose,
  onSubmit,
}: {
  state: ResourceDialogState
  pending: boolean
  onClose: () => void
  onSubmit: (fd: FormData, state: Exclude<ResourceDialogState, null>) => void
}) {
  const isEdit = state?.mode === 'edit'
  const resource = state?.mode === 'edit' ? state.resource : null
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState<FinanceCurrency>('USDT')

  // Reset fields whenever the dialog target changes.
  const key = resource?.id ?? state?.mode ?? 'closed'
  const [seen, setSeen] = useState<string>('')
  if (state && key !== seen) {
    setSeen(key)
    setName(resource?.name ?? '')
    setDescription(resource?.description ?? '')
    setCurrency(resource?.currency ?? 'USDT')
  }

  function submit() {
    if (!state) return
    const fd = new FormData()
    fd.set('name', name)
    fd.set('description', description)
    fd.set('currency', currency)
    if (resource) fd.set('archived', String(resource.archived))
    onSubmit(fd, state)
  }

  return (
    <Dialog
      open={!!state}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? 'Изменить ресурс' : 'Новый ресурс'}
          </DialogTitle>
          <DialogDescription>
            Ресурс верхнего уровня, например site.com.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="resource-name">Название</Label>
            <Input
              id="resource-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="site.com"
              autoFocus
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="resource-desc">Описание</Label>
            <Textarea
              id="resource-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Необязательно"
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label>Валюта</Label>
            <Select
              value={currency}
              onValueChange={(v) => setCurrency(v as FinanceCurrency)}
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="USDT">USDT</SelectItem>
                <SelectItem value="RUB">RUB (₽)</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Отмена</Button>} />
          <Button disabled={pending || !name.trim()} onClick={submit}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {isEdit ? 'Сохранить' : 'Добавить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------------------------------------------ */
/* Entry dialog                                                        */
/* ------------------------------------------------------------------ */

type EntryDialogState =
  | { mode: 'create'; sectionId: string }
  | { mode: 'edit'; entry: FinanceEntry }
  | null

function EntryDialog({
  state,
  pending,
  onClose,
  onSubmit,
}: {
  state: EntryDialogState
  pending: boolean
  onClose: () => void
  onSubmit: (fd: FormData, state: Exclude<EntryDialogState, null>) => void
}) {
  const isEdit = state?.mode === 'edit'
  const entry = state?.mode === 'edit' ? state.entry : null

  const [title, setTitle] = useState('')
  const [type, setType] = useState<FinanceEntryType>('expense')
  const [status, setStatus] = useState<FinanceEntryStatus>('planned')
  const [amount, setAmount] = useState('')
  const [entryDate, setEntryDate] = useState(todayISO())
  const [notes, setNotes] = useState('')

  const key =
    entry?.id ?? (state?.mode === 'create' ? state.sectionId : '') ?? 'closed'
  const [seen, setSeen] = useState<string>('')
  if (state && key !== seen) {
    setSeen(key)
    setTitle(entry?.title ?? '')
    setType(entry?.type ?? 'expense')
    setStatus(entry?.status ?? 'planned')
    setAmount(entry ? String(entry.amount) : '')
    setEntryDate(entry?.entryDate ?? todayISO())
    setNotes(entry?.notes ?? '')
  }

  function submit() {
    if (!state) return
    const fd = new FormData()
    fd.set('title', title)
    fd.set('type', type)
    fd.set('status', status)
    fd.set('amount', amount || '0')
    fd.set('entryDate', entryDate)
    fd.set('notes', notes)
    onSubmit(fd, state)
  }

  return (
    <Dialog
      open={!!state}
      onOpenChange={(o) => {
        if (!o) onClose()
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Изменить запись' : 'Новая запись'}</DialogTitle>
          <DialogDescription>
            Доход или расход со статусом, суммой и датой.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="entry-title">Название</Label>
            <Input
              id="entry-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Например: Закупка материалов"
              autoFocus
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Тип</Label>
              <Select
                value={type}
                onValueChange={(v) => setType(v as FinanceEntryType)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="income">Доход</SelectItem>
                  <SelectItem value="expense">Расход</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Статус</Label>
              <Select
                value={status}
                onValueChange={(v) => setStatus(v as FinanceEntryStatus)}
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="planned">Запланировано</SelectItem>
                  <SelectItem value="in_progress">В работе</SelectItem>
                  <SelectItem value="done">Выполнено</SelectItem>
                  <SelectItem value="cancelled">Отменено</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="entry-amount">Сумма</Label>
              <Input
                id="entry-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="entry-date">Дата</Label>
              <Input
                id="entry-date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="entry-notes">Заметки / ответы</Label>
            <Textarea
              id="entry-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Детали, ответы, ссылки…"
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Отмена</Button>} />
          <Button disabled={pending || !title.trim()} onClick={submit}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            {isEdit ? 'Сохранить' : 'Добавить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
