'use client'

import {
  Bell,
  BellOff,
  Check,
  Info,
  Reply,
  Tag,
  UserPlus,
} from 'lucide-react'
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
import { VirtualList } from '@/components/manager/virtual-list'
import { cn } from '@/lib/utils'
import { leadStatusOptionValue } from '@/lib/types'
import { useLeadStatusMeta } from '@/components/dictionaries-provider'
import type {
  ChannelType,
  Conversation,
  LeadStatus,
  NotLiquidReason,
} from '@/lib/types'
import { LEAD_STATUS_VISUAL, listStamp, visitorTag, type SortMode } from './visual'
import {
  ContactAvatar,
  Highlight,
  PresenceDot,
  SourceChip,
  StatusRadioItems,
} from './atoms'
import { ConversationListHeader } from './conversation-list-header'
import type { VisitorPresence, VisitorTyping } from './use-inbox-realtime'

/**
 * Left column of the inbox: header (search / sort / filters — see
 * ConversationListHeader) plus the virtualized conversation list with its
 * per-row context menu. All state lives in InboxView — this component is
 * purely presentational.
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
  hiddenForFocus = false,
}: {
  /** Whether a thread is currently open (hides the list on mobile). */
  active: boolean
  /**
   * Фокус-режим (навигация по кружкам/фото): список полностью скрыт, чтобы
   * диалог был виден целиком рядом с открытой карточкой лида.
   */
  hiddenForFocus?: boolean
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
  return (
    <div
      className={cn(
        'flex w-full flex-col border-r border-border md:w-[340px] md:shrink-0',
        active && 'hidden md:flex',
        hiddenForFocus && 'md:hidden',
      )}
    >
      <ConversationListHeader
        unreadTotal={unreadTotal}
        syncState={syncState}
        sortMode={sortMode}
        setSortMode={setSortMode}
        search={search}
        setSearch={setSearch}
        autopilot={autopilot}
        availableTypes={availableTypes}
        typeFilter={typeFilter}
        toggleType={toggleType}
        typeCounts={typeCounts}
        sources={sources}
        sourceFilter={sourceFilter}
        toggleSource={toggleSource}
        statusFilter={statusFilter}
        toggleStatus={toggleStatus}
        statusCounts={statusCounts}
        reasonFilter={reasonFilter}
        toggleReason={toggleReason}
        reasonCounts={reasonCounts}
        mutedCount={mutedCount}
        showMuted={showMuted}
        setShowMuted={setShowMuted}
        hasActiveFilters={hasActiveFilters}
        clearFilters={clearFilters}
        onOpenConversation={setActiveId}
      />

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
                      activeId === c.id ? 'bg-secondary hover:bg-secondary' : '',
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
