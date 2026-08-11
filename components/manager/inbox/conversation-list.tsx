'use client'

import { Fragment } from 'react'
import {
  Bell,
  BellOff,
  Check,
  Info,
  Reply,
  Search,
  SlidersHorizontal,
  Tag,
  UserPlus,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
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
import { VirtualList } from '@/components/manager/virtual-list'
import { cn } from '@/lib/utils'
import {
  LEAD_STATUS_ORDER,
  NOT_LIQUID_REASON_ORDER,
  leadStatusOptionValue,
} from '@/lib/types'
import {
  useLeadStatusMeta,
  useNotLiquidReasonMeta,
} from '@/components/dictionaries-provider'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  NotLiquidReason,
} from '@/lib/types'
import {
  CHANNEL_VISUAL,
  LEAD_STATUS_VISUAL,
  FilterChip,
  listStamp,
  visitorTag,
  type SortMode,
} from './visual'
import {
  ContactAvatar,
  Highlight,
  PresenceDot,
  SourceChip,
  StatusRadioItems,
  SyncBadge,
} from './atoms'
import type { VisitorPresence, VisitorTyping } from './use-inbox-realtime'

/**
 * Left column of the inbox: header with search, sort and multi-select filters,
 * plus the virtualized conversation list with its per-row context menu. All
 * state lives in InboxView — this component is purely presentational.
 */
export function ConversationList({
  active,
  activeId,
  setActiveId,
  setDetailsOpen,
  totalCount,
  filtered,
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
  hasActiveFilters,
  clearFilters,
  isMuted,
  presenceByConv,
  typingByConv,
  awaitingReply,
  dismissedOverrides,
  dismissReply,
  toggleMute,
  transferTargets,
  openTransfer,
  changeStatus,
}: {
  /** Whether a thread is currently open (hides the list on mobile). */
  active: boolean
  activeId: string | null
  setActiveId: (id: string) => void
  setDetailsOpen: (open: boolean) => void
  /** Total number of conversations before filtering. */
  totalCount: number
  filtered: Conversation[]
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
  hasActiveFilters: boolean
  clearFilters: () => void
  isMuted: (c: Conversation) => boolean
  presenceByConv: Record<string, VisitorPresence>
  typingByConv: Record<string, VisitorTyping>
  awaitingReply: Map<string, { waiting: boolean; since: number }>
  dismissedOverrides: Record<string, number>
  dismissReply: (conversationId: string, clear?: boolean) => void
  toggleMute: (conversationId: string, muted: boolean) => void
  transferTargets: { id: string; name: string; onLunch: boolean }[]
  openTransfer: (conversationId: string) => void
  changeStatus: (conversationId: string, optionValue: string) => void
}) {
  const LEAD_STATUS_META = useLeadStatusMeta()
  const NOT_LIQUID_REASON_META = useNotLiquidReasonMeta()
  return (
      <div
        className={cn(
          'flex w-full flex-col border-r border-border md:w-[340px] md:shrink-0',
          active && 'hidden md:flex',
        )}
      >
        {/* Header */}
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
                    onValueChange={(v) =>
                      setSortMode((v as SortMode) ?? 'recent')
                    }
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
                          className={cn(
                            'size-2 rounded-full',
                            CHANNEL_VISUAL[t].dot,
                          )}
                        />
                        {CHANNEL_VISUAL[t].short}
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
                            CHANNEL_VISUAL[s.type].dot,
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

        {/* List (virtualized — only near-viewport rows are mounted; see VirtualList) */}
        {filtered.length === 0 ? (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {totalCount === 0
                ? 'Пока нет диалогов.'
                : 'Ничего не найдено по фильтрам.'}
            </p>
          </div>
        ) : (
          <VirtualList
            items={filtered}
            getItemKey={(c) => c.id}
            estimateSize={76}
            className="scrollbar-thin min-h-0 flex-1 px-1.5 py-1.5"
            renderItem={(c) => (
              <ContextMenu key={c.id}>
                <ContextMenuTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setActiveId(c.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-[background-color,transform] duration-200 ease-[cubic-bezier(0.16,1,0.3,1)] hover:bg-muted/60 active:scale-[0.985]',
                        activeId === c.id
                          ? 'bg-secondary hover:bg-secondary'
                          : '',
                        c.aiHandoffPending && activeId !== c.id
                          ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/40 hover:bg-emerald-500/15'
                          : '',
                      )}
                    />
                  }
                >
                  <ContactAvatar
                    name={c.contactName}
                    channel={c.channelType}
                    channelId={c.channelId}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={cn(
                          'flex min-w-0 items-center gap-1 truncate text-sm',
                          c.unread > 0 ? 'font-semibold' : 'font-medium',
                        )}
                      >
                        {isMuted(c) ? (
                          <BellOff className="size-3 shrink-0 text-muted-foreground" />
                        ) : null}
                        {presenceByConv[c.id] ? (
                          <PresenceDot state={presenceByConv[c.id].state} />
                        ) : null}
                        <Highlight text={c.contactName} query={search} />
                        {c.contactUsername ? (
                          <span className="shrink-0 truncate text-[11px] font-normal text-muted-foreground">
                            @{c.contactUsername}
                          </span>
                        ) : null}
                        {visitorTag(c) ? (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
                            {visitorTag(c)}
                          </span>
                        ) : null}
                      </p>
                      <span
                        className={cn(
                          'shrink-0 text-[11px]',
                          c.unread > 0
                            ? 'font-medium text-primary'
                            : 'text-muted-foreground',
                        )}
                      >
                        {listStamp(c.lastMessageAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      {typingByConv[c.id] ? (
                        <p className="truncate text-xs font-medium text-primary">
                          печатает…
                        </p>
                      ) : (
                        <p
                          className={cn(
                            'truncate text-xs',
                            c.unread > 0
                              ? 'text-foreground/80'
                              : 'text-muted-foreground',
                          )}
                        >
                          <Highlight text={c.lastMessage} query={search} />
                        </p>
                      )}
                      {c.unread > 0 ? (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                          {c.unread}
                        </span>
                      ) : awaitingReply.get(c.id)?.waiting ? (
                        <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          <Reply className="size-3" />
                          ждёт ответа
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          LEAD_STATUS_VISUAL[c.status].dot,
                        )}
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {LEAD_STATUS_META[c.status].label}
                        {!c.statusManual ? ' · авто' : ''}
                      </span>
                      <SourceChip
                        conversation={c}
                        size="xs"
                        className="ml-auto max-w-[45%]"
                      />
                    </div>
                  </div>
                </ContextMenuTrigger>

                <ContextMenuContent>
                  <ContextMenuLabel>{c.contactName}</ContextMenuLabel>
                  <ContextMenuItem
                    onClick={() => {
                      setActiveId(c.id)
                      setDetailsOpen(true)
                    }}
                  >
                    <Info className="size-4" />
                    Данные и источник
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Tag className="size-4" />
                      Статус лида
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuRadioGroup
                        value={
                          c.statusManual
                            ? leadStatusOptionValue(c.status, c.statusDetail)
                            : 'auto'
                        }
                        onValueChange={(v) => changeStatus(c.id, v ?? 'auto')}
                      >
                        <StatusRadioItems Item={ContextMenuRadioItem} />
                      </ContextMenuRadioGroup>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  {awaitingReply.get(c.id)?.waiting ? (
                    <ContextMenuItem onClick={() => dismissReply(c.id)}>
                      <Check className="size-4" />
                      Не требует ответа
                    </ContextMenuItem>
                  ) : c.unread === 0 &&
                    (dismissedOverrides[c.id] || c.replyDismissedAt) ? (
                    <ContextMenuItem onClick={() => dismissReply(c.id, true)}>
                      <Reply className="size-4" />
                      Вернуть в ожидающие
                    </ContextMenuItem>
                  ) : null}
                  {isMuted(c) ? (
                    <ContextMenuItem onClick={() => toggleMute(c.id, false)}>
                      <Bell className="size-4" />
                      Включить уведомления
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem onClick={() => toggleMute(c.id, true)}>
                      <BellOff className="size-4" />
                      Заглушить контакт
                    </ContextMenuItem>
                  )}
                    {transferTargets.length > 0 ? (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => openTransfer(c.id)}>
                          <UserPlus className="size-4" />
                          Передать менеджеру
                        </ContextMenuItem>
                      </>
                    ) : null}
                  </ContextMenuContent>
                </ContextMenu>
            )}
          />
        )}
      </div>
  )
}
