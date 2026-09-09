'use client'

/**
 * Reusable filter-bar controls shared by every role's leads view (curator,
 * head). Each view still owns its toolbar container and any role-specific
 * buttons (e.g. the curator's Excel export); these are the pieces that were
 * previously copy-pasted verbatim between views.
 */

import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  LayoutGrid,
  List,
  ListFilter,
  Search,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'
import type { LeadsViewMode } from './use-leads-view-mode'

/** Status dropdown: all / none / each lead status with its tone dot. */
export function LeadsStatusFilter({
  value,
  onChange,
  searchExpanded,
}: {
  value: string
  onChange: (v: string) => void
  searchExpanded: boolean
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange((v as string) ?? '')}>
      <SelectTrigger
        className={cn(
          'h-9 gap-2 font-medium transition-all duration-300',
          searchExpanded && 'max-w-40',
        )}
        aria-label="Фильтр по статусу"
      >
        <ListFilter className="size-4 shrink-0 text-muted-foreground" />
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-auto min-w-44">
        <SelectItem value="">Все статусы (по умолчанию)</SelectItem>
        <SelectItem value="none">Без статуса</SelectItem>
        {LEAD_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  LEAD_STATUS_TONE[s].dot,
                )}
              />
              {LEAD_STATUS_LABELS[s]}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** Compact search: narrow by default, expands smoothly on focus / while typed. */
export function LeadsSearchInput({
  value,
  onChange,
  focused,
  onFocusedChange,
}: {
  value: string
  onChange: (v: string) => void
  focused: boolean
  onFocusedChange: (f: boolean) => void
}) {
  const expanded = focused || value.length > 0
  return (
    <div
      className={cn(
        'relative min-w-0 transition-all duration-300 ease-out',
        expanded ? 'flex-1 basis-64' : 'flex-none basis-44',
      )}
    >
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={() => onFocusedChange(true)}
        onBlur={() => onFocusedChange(false)}
        placeholder={expanded ? 'ФИО, телефон, @username, город…' : 'Поиск'}
        className="h-9 pl-8 pr-8"
        aria-label="Поиск по лидам"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Очистить поиск"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  )
}

/** Newest/oldest sort toggle; hides its label while the search bar is expanded. */
export function LeadsSortButton({
  sort,
  onToggle,
  searchExpanded,
}: {
  sort: 'newest' | 'oldest'
  onToggle: () => void
  searchExpanded: boolean
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      className="h-9"
      onClick={onToggle}
      aria-label="Переключить сортировку"
      title={sort === 'newest' ? 'Сначала новые' : 'Сначала старые'}
    >
      {sort === 'newest' ? (
        <ArrowDownWideNarrow className="size-4 shrink-0" />
      ) : (
        <ArrowUpNarrowWide className="size-4 shrink-0" />
      )}
      {!searchExpanded ? (sort === 'newest' ? 'Новые' : 'Старые') : null}
    </Button>
  )
}

/** List / grid view switcher. */
export function LeadsViewToggle({
  view,
  onSwitch,
}: {
  view: LeadsViewMode
  onSwitch: (v: LeadsViewMode) => void
}) {
  return (
    <div className="flex h-9 items-center rounded-lg border border-border p-1">
      <button
        type="button"
        onClick={() => onSwitch('list')}
        aria-label="Вид: список"
        aria-pressed={view === 'list'}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
          view === 'list'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <List className="size-4 shrink-0" />
      </button>
      <button
        type="button"
        onClick={() => onSwitch('grid')}
        aria-label="Вид: карточки"
        aria-pressed={view === 'grid'}
        className={cn(
          'flex h-7 w-7 items-center justify-center rounded-md transition-colors',
          view === 'grid'
            ? 'bg-muted text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <LayoutGrid className="size-4 shrink-0" />
      </button>
    </div>
  )
}
