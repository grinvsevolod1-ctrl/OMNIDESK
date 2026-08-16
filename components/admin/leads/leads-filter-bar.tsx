'use client'

import {
  ArrowDownWideNarrow,
  ArrowUpNarrowWide,
  FileSpreadsheet,
  ListFilter,
  Loader2,
  Search,
  Users,
  X,
} from 'lucide-react'
import { LeadsTrashDialog } from '@/components/admin/leads-trash-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { CuratorWithLoad } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'

/**
 * Панель фильтров списка «Все лиды»: менеджер по кадрам, статус, единый
 * поиск, сортировка, выгрузка в Excel и корзина. Презентационный —
 * состояние и колбэки приходят из контейнера AllLeadsSection.
 */
export function LeadsFilterBar({
  curatorId,
  status,
  search,
  sort,
  orphanedOnly,
  exporting,
  searchExpanded,
  curators,
  onCuratorChange,
  onStatusChange,
  onSearchChange,
  onSearchFocus,
  onSearchBlur,
  onToggleSort,
  onExport,
  onTrashChanged,
}: {
  curatorId: string
  status: string
  search: string
  sort: 'newest' | 'oldest'
  orphanedOnly: boolean
  exporting: boolean
  searchExpanded: boolean
  curators: CuratorWithLoad[]
  onCuratorChange: (curatorId: string) => void
  onStatusChange: (status: string) => void
  onSearchChange: (search: string) => void
  onSearchFocus: () => void
  onSearchBlur: () => void
  onToggleSort: () => void
  onExport: () => void
  onTrashChanged: () => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select
        value={curatorId}
        onValueChange={(v) => onCuratorChange((v as string) ?? '')}
        disabled={orphanedOnly}
      >
        <SelectTrigger
          className={cn(
            'h-9 gap-2 font-medium transition-all duration-300',
            searchExpanded ? 'max-w-52' : 'max-w-72',
          )}
          aria-label="Фильтр по менеджеру по кадрам"
        >
          <Users className="size-4 shrink-0 text-muted-foreground" />
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="w-auto min-w-56">
          <SelectItem value="">Все менеджеры по кадрам (по умолчанию)</SelectItem>
          {curators.map((c) => (
            <SelectItem key={c.id} value={c.id}>
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate">{c.name}</span>
                {c.cities?.length || c.city ? (
                  <span className="max-w-40 truncate text-xs text-muted-foreground">
                    {c.cities?.length ? c.cities.join(', ') : c.city}
                  </span>
                ) : null}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Select
        value={status}
        onValueChange={(v) => onStatusChange((v as string) ?? '')}
      >
        <SelectTrigger
          className="h-9 gap-2 font-medium"
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

      {/* Единый поиск: дата ДД.ММ.ГГГГ / ФИО / телефон / @username / город /
          регион. Компактный по умолчанию — плавно раскрывается на фокусе
          (или пока есть текст), а соседние элементы ужимаются. */}
      <div
        className={cn(
          'relative min-w-0 transition-all duration-300 ease-out',
          searchExpanded ? 'flex-1 basis-64' : 'flex-none basis-44',
        )}
      >
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        {/* Поиск в реальном времени: debounce 350мс, Enter не нужен. */}
        <Input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onFocus={onSearchFocus}
          onBlur={onSearchBlur}
          placeholder={
            searchExpanded
              ? 'Дата, ФИО, телефон, @username, город, сотрудник…'
              : 'Поиск'
          }
          className="h-9 pl-8 pr-8"
          aria-label="Поиск по лидам"
        />
        {search ? (
          <button
            type="button"
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground transition-colors hover:text-foreground"
            aria-label="Очистить поиск"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      <Button
        variant="outline"
        size="sm"
        className="h-9"
        onClick={onToggleSort}
        aria-label="Переключить сортировку"
        title={sort === 'newest' ? 'Сначала новые' : 'Сначала старые'}
      >
        {sort === 'newest' ? (
          <ArrowDownWideNarrow className="size-4 shrink-0" />
        ) : (
          <ArrowUpNarrowWide className="size-4 shrink-0" />
        )}
        {/* Пока поиск раскрыт — только иконки, чтобы всё влезло в строку */}
        {!searchExpanded ? (sort === 'newest' ? 'Новые' : 'Старые') : null}
      </Button>

      <Button
        variant="outline"
        size="sm"
        className="h-9"
        disabled={exporting}
        onClick={onExport}
        aria-label="Выгрузить в Excel"
        title="Выгрузить текущую выборку в Excel"
      >
        {exporting ? (
          <Loader2 className="size-4 shrink-0 animate-spin" />
        ) : (
          <FileSpreadsheet className="size-4 shrink-0" />
        )}
        {!searchExpanded ? 'Excel' : null}
      </Button>

      <LeadsTrashDialog onChanged={onTrashChanged} />
    </div>
  )
}
