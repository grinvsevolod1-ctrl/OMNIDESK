'use client'

import { Fragment } from 'react'
import {
  ArrowLeftRight,
  BellOff,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { AutopilotToggle } from '@/components/manager/autopilot-toggle'
import { cn } from '@/lib/utils'
import {
  LEAD_STATUS_ORDER,
  NOT_LIQUID_REASON_ORDER,
} from '@/lib/types'
import {
  useLeadStatusMeta,
  useNotLiquidReasonMeta,
} from '@/components/dictionaries-provider'
import type { ChannelType, LeadStatus, NotLiquidReason } from '@/lib/types'
import {
  channelVisual,
  LEAD_STATUS_VISUAL,
  FilterChip,
  type SortMode,
} from './visual'
import { SyncBadge } from './atoms'
import { NewTelegramChatButton } from './new-telegram-chat'

/**
 * Inbox list header: title with unread badge, sync state, sort menu, search
 * box, autopilot master switch and the multi-select filter bar. Split from
 * ConversationList (conversation-list.tsx) — purely presentational, all state
 * lives in InboxView.
 */
export function ConversationListHeader({
  unreadTotal,
  syncState,
  sortMode,
  setSortMode,
  search,
  setSearch,
  autopilot,
  availableTypes,
  typeFilter,
  toggleType,
  typeCounts,
  sources,
  sourceFilter,
  toggleSource,
  statusFilter,
  toggleStatus,
  statusCounts,
  reasonFilter,
  toggleReason,
  reasonCounts,
  mutedCount,
  showMuted,
  setShowMuted,
  transferredCount,
  viewBucket,
  setViewBucket,
  hasActiveFilters,
  clearFilters,
  onOpenConversation,
}: {
  unreadTotal: number
  syncState: 'connecting' | 'live' | 'offline'
  sortMode: SortMode
  setSortMode: (mode: SortMode) => void
  search: string
  setSearch: (q: string) => void
  autopilot?: { enabled: boolean; enabledCount: number }
  availableTypes: ChannelType[]
  typeFilter: Set<ChannelType>
  toggleType: (t: ChannelType) => void
  typeCounts: Record<ChannelType, number>
  sources: { id: string; type: ChannelType; label: string; count: number }[]
  sourceFilter: Set<string>
  toggleSource: (id: string) => void
  statusFilter: Set<LeadStatus>
  toggleStatus: (s: LeadStatus) => void
  statusCounts: Record<LeadStatus, number>
  reasonFilter: Set<NotLiquidReason>
  toggleReason: (r: NotLiquidReason) => void
  reasonCounts: Record<NotLiquidReason, number>
  mutedCount: number
  showMuted: boolean
  setShowMuted: (updater: (v: boolean) => boolean) => void
  /** Кол-во диалогов, которые куратор ведёт прямо сейчас (для чипа «Переданные»). */
  transferredCount: number
  /** Текущий сегмент инбокса. */
  viewBucket: 'active' | 'transferred' | 'rework'
  setViewBucket: (b: 'active' | 'transferred' | 'rework') => void
  hasActiveFilters: boolean
  clearFilters: () => void
  /** Открыть диалог по id — для кнопки «Написать в ТГ» после отправки. */
  onOpenConversation?: (id: string) => void
}) {
  const LEAD_STATUS_META = useLeadStatusMeta()
  const NOT_LIQUID_REASON_META = useNotLiquidReasonMeta()
  return (
    <div className="flex flex-col gap-2.5 border-b border-border px-3 py-3">
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold tracking-tight">Чаты</h2>
          {unreadTotal > 0 ? (
            <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
              {unreadTotal}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <SyncBadge state={syncState} />
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Фильтры и сортировка"
                >
                  <SlidersHorizontal className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>Сортировка</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={sortMode}
                onValueChange={(v) => setSortMode((v as SortMode) ?? 'recent')}
              >
                <DropdownMenuRadioItem value="recent">
                  Сначала новые
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="oldest">
                  Сначала старые
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="unread">
                  По непрочитанным
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="status">
                  По статусу
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск по диалогам и сообщениям"
          className="h-9 rounded-full border-transparent bg-muted pl-9 text-sm focus-visible:bg-card"
          aria-label="Поиск по диалогам и сообщениям"
        />
        {search ? (
          <button
            type="button"
            onClick={() => setSearch('')}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Очистить поиск"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {/* Autopilot master switch (links to the full rule builder). Only
          rendered when the inbox page managed to read autopilot status. */}
      {autopilot ? (
        <AutopilotToggle
          initialEnabled={autopilot.enabled}
          enabledCount={autopilot.enabledCount}
        />
      ) : null}

      {/* Multi-select filter bar: hover-open menus with checkboxes. An empty
          selection means "no filter". Sources is shown only when more than
          one source is connected; channel type only when several types are
          present. */}
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Ручной аутрич: лид оставил ник в другом канале (например, VK) —
            менеджер пишет ему в TG с рабочего аккаунта, не с личного. */}
        <NewTelegramChatButton onOpenConversation={onOpenConversation} />

        {availableTypes.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              openOnHover
              delay={120}
              render={
                <FilterChip
                  label="Тип"
                  count={typeFilter.size}
                  active={typeFilter.size > 0}
                />
              }
            />
            <DropdownMenuContent align="start" className="w-52">
              <DropdownMenuLabel>Тип канала</DropdownMenuLabel>
              {availableTypes.map((t) => (
                <DropdownMenuCheckboxItem
                  key={t}
                  checked={typeFilter.has(t)}
                  onCheckedChange={() => toggleType(t)}
                  closeOnClick={false}
                >
                  <span className="flex flex-1 items-center gap-2">
                    <span
                      className={cn('size-2 rounded-full', channelVisual(t).dot)}
                    />
                    {channelVisual(t).short}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {typeCounts[t]}
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        {sources.length > 1 ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              openOnHover
              delay={120}
              render={
                <FilterChip
                  label="Источники"
                  count={sourceFilter.size}
                  active={sourceFilter.size > 0}
                />
              }
            />
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuLabel>Источники</DropdownMenuLabel>
              {sources.map((s) => (
                <DropdownMenuCheckboxItem
                  key={s.id}
                  checked={sourceFilter.has(s.id)}
                  onCheckedChange={() => toggleSource(s.id)}
                  closeOnClick={false}
                >
                  <span className="flex flex-1 items-center gap-2">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        channelVisual(s.type).dot,
                      )}
                    />
                    <span className="truncate">{s.label}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {s.count}
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger
            openOnHover
            delay={120}
            render={
              <FilterChip
                label="Статусы"
                count={statusFilter.size}
                active={statusFilter.size > 0}
              />
            }
          />
          <DropdownMenuContent align="start" className="w-56">
            <DropdownMenuLabel>Статусы</DropdownMenuLabel>
            {LEAD_STATUS_ORDER.map((s) => (
              <Fragment key={s}>
                <DropdownMenuCheckboxItem
                  checked={statusFilter.has(s)}
                  onCheckedChange={() => toggleStatus(s)}
                  closeOnClick={false}
                >
                  <span className="flex flex-1 items-center gap-2">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        LEAD_STATUS_VISUAL[s].dot,
                      )}
                    />
                    {LEAD_STATUS_META[s].label}
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {statusCounts[s]}
                    </span>
                  </span>
                </DropdownMenuCheckboxItem>
                {/* «Не ликвид» reason refinements (Гео / -18 / NA / TRASH) */}
                {s === 'not_liquid'
                  ? NOT_LIQUID_REASON_ORDER.map((r) => (
                      <DropdownMenuCheckboxItem
                        key={r}
                        checked={reasonFilter.has(r)}
                        onCheckedChange={() => toggleReason(r)}
                        closeOnClick={false}
                        className="pl-8"
                      >
                        <span className="flex flex-1 items-center gap-2 text-xs">
                          {NOT_LIQUID_REASON_META[r].label}
                          <span className="ml-auto text-[10px] text-muted-foreground">
                            {reasonCounts[r]}
                          </span>
                        </span>
                      </DropdownMenuCheckboxItem>
                    ))
                  : null}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* «Переданные»: диалоги, которые куратор ведёт прямо сейчас. По
            умолчанию они скрыты из активного списка — этот чип открывает их
            отдельным сегментом. Показываем, пока есть такие диалоги или пока
            сегмент открыт (чтобы был путь обратно). */}
        {transferredCount > 0 || viewBucket === 'transferred' ? (
          <button
            type="button"
            aria-pressed={viewBucket === 'transferred'}
            onClick={() =>
              setViewBucket(
                viewBucket === 'transferred' ? 'active' : 'transferred',
              )
            }
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
              viewBucket === 'transferred'
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-muted',
            )}
            title={
              viewBucket === 'transferred'
                ? 'Вернуться к активным диалогам'
                : 'Показать диалоги, которые ведёт куратор'
            }
          >
            <ArrowLeftRight className="size-3" />
            Переданные
            <span className="text-[10px] opacity-60">{transferredCount}</span>
          </button>
        ) : null}

        {mutedCount > 0 ? (
          <button
            type="button"
            aria-pressed={showMuted}
            onClick={() => setShowMuted((v) => !v)}
            className={cn(
              'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
              showMuted
                ? 'bg-muted text-foreground'
                : 'text-muted-foreground hover:bg-muted',
            )}
            title={
              showMuted
                ? 'Скрыть заглушённые контакты'
                : 'Показать заглушённые контакты'
            }
          >
            <BellOff className="size-3" />
            {showMuted ? 'Скрыть заглушённые' : 'Заглушённые'}
            <span className="text-[10px] opacity-60">{mutedCount}</span>
          </button>
        ) : null}

        {hasActiveFilters ? (
          <button
            type="button"
            onClick={clearFilters}
            className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <X className="size-3" />
            Сбросить
          </button>
        ) : null}
      </div>
    </div>
  )
}
