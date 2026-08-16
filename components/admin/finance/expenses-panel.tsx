'use client'

/**
 * Expenses tab for a finance resource. Presentational container: all client
 * state lives in the useExpenses hook, rows and table chrome live in the
 * expenses/ subfolder. Data mutations that touch the parent's optimistic
 * state are delegated via props (run + on* callbacks).
 */

import { FolderPlus, Layers, ListChecks, Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import {
  createSectionAction,
  renameSectionAction,
  type FinanceResult,
} from '@/app/actions/finance'
import { EmptyState } from '@/components/page-parts'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
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
import {
  FINANCE_ENTRY_STATUSES,
  type FinanceEntry,
  type FinanceResource,
  type FinanceSection,
} from '@/lib/finance-types'
import { STATUS_META, formatUsd } from '@/components/admin/finance/finance-utils'
import { ExpenseRow } from './expenses/expense-row'
import { AddSectionInline, SortableTh } from './expenses/table-parts'
import { useExpenses, type StatusFilter } from './expenses/use-expenses'

export function ExpensesPanel({
  resource,
  sections,
  entries,
  pending,
  run,
  onAddEntry,
  onEditEntry,
  onDeleteEntry,
  onDeleteSection,
}: {
  resource: FinanceResource
  sections: FinanceSection[]
  entries: FinanceEntry[]
  pending: boolean
  run: (fn: () => Promise<FinanceResult>, onOk?: () => void) => void
  onAddEntry: (sectionId: string) => void
  onEditEntry: (entry: FinanceEntry) => void
  onDeleteEntry: (entry: FinanceEntry) => void
  onDeleteSection: (section: FinanceSection) => void
}) {
  const {
    activeSection,
    setSectionId,
    newSection,
    setNewSection,
    renaming,
    setRenaming,
    renameValue,
    setRenameValue,
    search,
    setSearch,
    statusFilter,
    setStatusFilter,
    sortField,
    sortDir,
    expanded,
    filtered,
    sectionTotal,
    totalFor,
    toggleSort,
    toggleExpanded,
  } = useExpenses(sections, entries)

  return (
    <div className="flex flex-col gap-4">
      {/* Section tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {sections.map((s) => {
          const active = activeSection?.id === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSectionId(s.id)}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card hover:bg-muted',
              )}
            >
              <Layers className="size-3.5 text-muted-foreground" />
              <span className="max-w-[160px] truncate font-medium">
                {s.name}
              </span>
              <span className="tabular-nums text-xs text-muted-foreground">
                {formatUsd(totalFor(s.id))}
              </span>
            </button>
          )
        })}
        <AddSectionInline
          value={newSection}
          onChange={setNewSection}
          pending={pending}
          onSubmit={() => {
            const name = newSection.trim()
            if (!name) return
            run(() => createSectionAction(resource.id, name), () =>
              setNewSection(''),
            )
          }}
        />
      </div>

      {!activeSection ? (
        <EmptyState
          icon={FolderPlus}
          title="Нет вкладок расходов"
          description="Создайте вкладку (например, «Материалы» или «Хостинг»), чтобы добавлять расходы."
        />
      ) : (
        <>
          {/* Section toolbar */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{activeSection.name}</h3>
                <Badge variant="outline" className="tabular-nums font-medium">
                  {formatUsd(sectionTotal)}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setRenaming(activeSection)
                    setRenameValue(activeSection.name)
                  }}
                >
                  <Pencil className="size-4" /> Переименовать
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  onClick={() => onDeleteSection(activeSection)}
                  aria-label="Удалить вкладку"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по названию, контрагенту, заметке…"
                  className="pl-3"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as StatusFilter)}
              >
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue placeholder="Статус" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все статусы</SelectItem>
                  {FINANCE_ENTRY_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="gap-1.5"
                onClick={() => onAddEntry(activeSection.id)}
              >
                <Plus className="size-4" /> Расход
              </Button>
            </div>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="Нет расходов"
              description="Добавьте первый расход в эту вкладку."
              action={
                <Button
                  className="gap-1.5"
                  onClick={() => onAddEntry(activeSection.id)}
                >
                  <Plus className="size-4" /> Добавить расход
                </Button>
              }
            />
          ) : (
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="w-8 px-3 py-2.5" />
                      <SortableTh
                        label="Расход"
                        field="title"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <th className="px-3 py-2.5 font-medium">Контрагент</th>
                      <SortableTh
                        label="Статус"
                        field="status"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="Дата"
                        field="date"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="Сумма"
                        field="amount"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                        align="right"
                      />
                      <th className="w-20 px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => {
                      const isOpen = expanded.has(e.id)
                      const doneTasks = e.tasks.filter((t) => t.done).length
                      return (
                        <ExpenseRow
                          key={e.id}
                          entry={e}
                          currency={resource.currency}
                          isOpen={isOpen}
                          doneTasks={doneTasks}
                          pending={pending}
                          onToggle={() => toggleExpanded(e.id)}
                          onEdit={() => onEditEntry(e)}
                          onDelete={() => onDeleteEntry(e)}
                          run={run}
                        />
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Rename section dialog */}
      <Dialog
        open={renaming != null}
        onOpenChange={(o) => {
          if (!o) setRenaming(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переименовать вкладку</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-section">Название</Label>
            <Input
              id="rename-section"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Отмена</Button>} />
            <Button
              disabled={pending || !renameValue.trim()}
              onClick={() => {
                if (!renaming) return
                run(
                  () => renameSectionAction(renaming.id, renameValue.trim()),
                  () => setRenaming(null),
                )
              }}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Сохранить'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
