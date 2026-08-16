'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SourcesOverview } from '@/lib/data/sources'
import { cn } from '@/lib/utils'
import { SourceCard } from './source-card'

type SortKey = 'people' | 'transferred' | 'expense' | 'name'

/** От скольких источников показывать поиск. */
const SEARCH_THRESHOLD = 12
/** Сколько карточек видно до кнопки «Показать все». */
const COLLAPSE_LIMIT = 24

/** Служебный id системной карточки «Без источника». */
export const UNASSIGNED_ID = '__unassigned__'

/**
 * Сетка источников: масштабируется до 100+ карточек — поиск, сортировка,
 * авто-заполняющаяся сетка и сворачивание длинного списка.
 */
export function SourceGrid({
  overview,
  activeId,
  onSelect,
}: {
  overview: SourcesOverview
  activeId: string | null
  onSelect: (id: string) => void
}) {
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<SortKey>('people')
  const [expanded, setExpanded] = useState(false)

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let list = overview.items
    if (needle) {
      list = list.filter((s) => s.name.toLowerCase().includes(needle))
    }
    const sorted = [...list].sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name, 'ru')
      return b.stats[sort] - a.stats[sort]
    })
    return sorted
  }, [overview.items, q, sort])

  const collapsed = !expanded && filtered.length > COLLAPSE_LIMIT
  const visible = collapsed ? filtered.slice(0, COLLAPSE_LIMIT) : filtered

  const showSearch = overview.items.length >= SEARCH_THRESHOLD
  const un = overview.unassigned

  return (
    <section aria-label="Источники" className="flex flex-col gap-3">
      {(showSearch || overview.items.length > 1) && (
        <div className="flex flex-wrap items-center gap-2">
          {showSearch ? (
            <div className="relative w-full max-w-60">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Найти источник…"
                className="h-8 pl-8"
                aria-label="Поиск источника"
              />
            </div>
          ) : null}
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-8 w-40" aria-label="Сортировка">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="people">По трафику</SelectItem>
              <SelectItem value="transferred">По лидам</SelectItem>
              <SelectItem value="expense">По расходу</SelectItem>
              <SelectItem value="name">По имени</SelectItem>
            </SelectContent>
          </Select>
          {q && filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground">Ничего не найдено</p>
          ) : null}
        </div>
      )}

      <div className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-3">
        {visible.map((item) => (
          <SourceCard
            key={item.id}
            item={item}
            active={item.id === activeId}
            onSelect={onSelect}
          />
        ))}

        {/* Системная карточка каналов вне источников — показываем без фильтра
            поиска только когда есть такие каналы. */}
        {un && !q ? (
          <SourceCard
            item={{
              id: UNASSIGNED_ID,
              name: 'Без источника',
              currency: 'USDT',
              createdAt: '',
              channels: un.channels,
              stats: un.stats,
            }}
            active={activeId === UNASSIGNED_ID}
            onSelect={onSelect}
          />
        ) : null}
      </div>

      {collapsed || (expanded && filtered.length > COLLAPSE_LIMIT) ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown
            className={cn('size-4 transition-transform', expanded && 'rotate-180')}
          />
          {collapsed ? `Показать все (${filtered.length})` : 'Свернуть'}
        </Button>
      ) : null}
    </section>
  )
}
