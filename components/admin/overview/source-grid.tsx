'use client'

import { useMemo, useState } from 'react'
import { ChevronDown, LayoutGrid, Rows3, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SourceOverviewItem, SourcesOverview } from '@/lib/data/sources'
import { cn } from '@/lib/utils'
import { SourceCard, type CardVariant } from './source-card'
import { SourceList } from './source-list'
import type { OverviewView } from './use-overview-prefs'

/** От скольких источников показывать поиск. */
const SEARCH_THRESHOLD = 12
/** Сколько карточек видно до кнопки «Показать все». */
const COLLAPSE_LIMIT = 24

/** Служебный id системной карточки «Без источника». */
export const UNASSIGNED_ID = '__unassigned__'

/**
 * Сетка/список источников. Плотность карточек адаптируется под их число:
 * один источник — hero на всю ширину со всеми цифрами, два-три — широкие,
 * дальше — компактная авто-сетка. Вид (карточки/список) выбирает админ,
 * выбор запоминается.
 */
export function SourceGrid({
  overview,
  activeId,
  onSelect,
  prev,
  view,
  onViewChange,
}: {
  overview: SourcesOverview
  activeId: string | null
  onSelect: (id: string) => void
  /** id источника -> люди за прошлый период (для дельт на карточках). */
  prev?: Record<string, { people: number }>
  view: OverviewView
  onViewChange: (view: OverviewView) => void
}) {
  const [q, setQ] = useState('')
  const [expanded, setExpanded] = useState(false)

  // Всегда по трафику (людей написало) — самые живые источники сверху.
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    let list = overview.items
    if (needle) {
      list = list.filter((s) => s.name.toLowerCase().includes(needle))
    }
    return [...list].sort((a, b) => b.stats.people - a.stats.people)
  }, [overview.items, q])

  const un = overview.unassigned

  // Системная карточка участвует в раскладке наравне с источниками.
  const unassignedItem: SourceOverviewItem | null =
    un && !q
      ? {
          id: UNASSIGNED_ID,
          name: 'Без источника',
          currency: 'USDT',
          createdAt: '',
          channels: un.channels,
          stats: un.stats,
        }
      : null

  const allItems = unassignedItem ? [...filtered, unassignedItem] : filtered

  const collapsed = !expanded && allItems.length > COLLAPSE_LIMIT
  const visible = collapsed ? allItems.slice(0, COLLAPSE_LIMIT) : allItems

  const showSearch = overview.items.length >= SEARCH_THRESHOLD

  // Плотность: 1 — hero, 2-3 — wide, дальше compact.
  const variant: CardVariant =
    allItems.length === 1 ? 'hero' : allItems.length <= 3 ? 'wide' : 'compact'

  return (
    <section aria-label="Источники" className="flex flex-col gap-3">
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

        {q && filtered.length === 0 ? (
          <p className="text-sm text-muted-foreground">Ничего не найдено</p>
        ) : null}

        {/* Переключатель вида — выбор запоминается */}
        <div
          role="group"
          aria-label="Вид"
          className="ml-auto flex items-center rounded-lg border border-border p-0.5"
        >
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewChange('cards')}
            className={cn(
              'h-7 rounded-md px-2',
              view === 'cards'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground',
            )}
            aria-pressed={view === 'cards'}
            aria-label="Карточками"
          >
            <LayoutGrid className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onViewChange('list')}
            className={cn(
              'h-7 rounded-md px-2',
              view === 'list'
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground',
            )}
            aria-pressed={view === 'list'}
            aria-label="Списком"
          >
            <Rows3 className="size-4" />
          </Button>
        </div>
      </div>

      {view === 'list' ? (
        <SourceList
          items={visible}
          activeId={activeId}
          onSelect={onSelect}
          prev={prev}
        />
      ) : (
        <div
          className={cn(
            'grid gap-3',
            variant === 'hero' && 'grid-cols-1',
            variant === 'wide' &&
              'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
            variant === 'compact' &&
              'grid-cols-[repeat(auto-fill,minmax(230px,1fr))]',
          )}
        >
          {visible.map((item) => (
            <SourceCard
              key={item.id}
              item={item}
              active={item.id === activeId}
              onSelect={onSelect}
              prevPeople={prev?.[item.id]?.people}
              variant={variant}
            />
          ))}
        </div>
      )}

      {collapsed || (expanded && allItems.length > COLLAPSE_LIMIT) ? (
        <Button
          variant="ghost"
          size="sm"
          className="self-center text-muted-foreground"
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown
            className={cn('size-4 transition-transform', expanded && 'rotate-180')}
          />
          {collapsed ? `Показать все (${allItems.length})` : 'Свернуть'}
        </Button>
      ) : null}
    </section>
  )
}
