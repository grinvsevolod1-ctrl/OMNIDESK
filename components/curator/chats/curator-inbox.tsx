'use client'

/**
 * Раздел «Чаты» куратора: список переданных диалогов + тред + композер.
 * Полноэкранная раскладка (dashboard-shell отдаёт /curator/chats как fullBleed,
 * без полей и внешнего скролла — как менеджерский инбокс). Тред целиком —
 * ОБЩЕЕ ядро с менеджером (`components/shared/inbox/thread-pane` поверх
 * общих хуков `use-message-actions` / `use-thread-history`): куратору
 * доступен полный набор действий — ответ, копия, реакции, редактирование
 * своих, удаление, пересылка, стикеры, голосовые и отложенная отправка.
 * Роль подключается адаптером `curator-thread-adapter` (curator-scoped
 * серверные экшены, см. app/actions/curator-messages). Состояние — в
 * use-curator-chats, здесь только вёрстка списка, шапки и инфо-панели.
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import {
  ArrowLeft,
  ArrowDownUp,
  Check,
  Info,
  MessageCircle,
  Search,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { useDrafts } from '@/components/manager/inbox/use-drafts'
import type { Conversation, Message } from '@/lib/types'
import { ContactAvatar } from '@/components/manager/inbox/atoms'
import { useThreadScroll } from '@/components/manager/inbox/use-thread-scroll'
import { CHANNEL_VISUAL } from '@/components/manager/inbox/visual'
import type { ForwardTarget } from '@/components/manager/message-context-menu'
import { ThreadPane } from '@/components/shared/inbox/thread-pane'
import type { useMessageActions } from '@/components/shared/inbox/use-message-actions'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { CuratorOutreachButton } from '@/components/curator/chats/curator-outreach'
import { ConversationRow } from '@/components/curator/chats/curator-conversation-row'
import { CuratorInfoPanel } from '@/components/curator/chats/curator-info-panel'
import { useCuratorChats } from '@/components/curator/chats/use-curator-chats'
import { useShellHeader } from '@/components/dashboard-shell'
import type { PanelChannelType } from '@/lib/types'
import type { CuratorConversationStatus } from '@/lib/data/curator-conversations'

type ListFilter = 'all' | 'unread'
type SortMode = 'recent' | 'unread' | 'name'

const SORT_LABELS: Record<SortMode, string> = {
  recent: 'Сначала новые',
  unread: 'Непрочитанные',
  name: 'По имени',
}

export function CuratorInbox({
  conversations,
  messagesByConversation,
  leadStatusByConversation,
  currentUser,
  outreachAvailable = false,
}: {
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  /** Кураторский статус лида на диалог (свой набор статусов, миграция 151). */
  leadStatusByConversation: Record<string, CuratorConversationStatus>
  currentUser: string
  /** Доступен ли аккаунт для исходящих (кнопка «Написать в ТГ» в шапке). */
  outreachAvailable?: boolean
}) {
  const router = useRouter()
  // Форма статуса и бейджи используют кураторский статус лида этого диалога.
  // После подтверждения статуса перезапрашиваем серверную страницу — свежий
  // статус приезжает в leadStatusByConversation. useCallback — чтобы не ломать
  // мемоизацию потомков лишней новой ссылкой на каждый рендер.
  const onStatusSaved = useCallback(() => router.refresh(), [router])
  const {
    activeId,
    setActiveId,
    active,
    thread,
    threadLoading,
    loadingOlder,
    noOlder,
    loadOlder,
    actions,
    forwardTargets,
    pending,
  } = useCuratorChats({ conversations, messagesByConversation, currentUser })

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ListFilter>('all')
  const [sort, setSort] = useState<SortMode>('recent')
  const [infoOpen, setInfoOpen] = useState(false)

  // Пока диалог открыт, его шапка (назад + данные лида) рисуется через портал в
  // единственной шапке дашборда — второй полосы-заголовка нет. Флаг прячет
  // бургер/ролевые кнопки на мобиле (см. useShellHeader).
  const shellHeader = useShellHeader()
  useEffect(() => {
    shellHeader?.setThreadOpen(Boolean(active))
    return () => shellHeader?.setThreadOpen(false)
  }, [active, shellHeader])

  const totalUnread = useMemo(
    () => conversations.reduce((sum, c) => sum + (c.unread || 0), 0),
    [conversations],
  )

  // Фильтр (поиск + «непрочитанные») и сортировка. Держим в одном useMemo,
  // чтобы список пересобирался только при изменении входов, а не на каждый
  // рендер (частые из-за realtime/router.refresh). Сортировка не мутирует
  // conversations — работаем по копии.
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = conversations.filter((c) => {
      if (filter === 'unread' && !(c.unread > 0)) return false
      if (!q) return true
      return (
        c.contactName.toLowerCase().includes(q) ||
        (c.contactUsername ?? '').toLowerCase().includes(q) ||
        (c.lastMessage ?? '').toLowerCase().includes(q)
      )
    })
    const byRecent = (a: Conversation, b: Conversation) =>
      new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
    const sorted = [...list]
    if (sort === 'recent') {
      sorted.sort(byRecent)
    } else if (sort === 'unread') {
      // Непрочитанные сверху (по числу непрочитанных), внутри — свежие первыми.
      sorted.sort(
        (a, b) => (b.unread || 0) - (a.unread || 0) || byRecent(a, b),
      )
    } else {
      sorted.sort((a, b) =>
        a.contactName.localeCompare(b.contactName, 'ru'),
      )
    }
    return sorted
  }, [conversations, search, filter, sort])

  // Выбор диалога — стабильная ссылка, чтобы мемоизированные строки списка не
  // перерисовывались все разом на каждый рендер родителя.
  const handleSelectConversation = useCallback(
    (id: string) => {
      setActiveId(id)
      setInfoOpen(false)
    },
    [setActiveId],
  )

  return (
    <div className="relative flex h-full overflow-hidden bg-background">
      {/* ------------------------------- Список ------------------------------ */}
      <aside
        className={cn(
          'flex w-full flex-col border-r border-border bg-card md:w-80 lg:w-[22rem]',
          activeId ? 'hidden md:flex' : 'flex',
        )}
      >
        <div className="flex flex-col gap-3 border-b border-border p-3">
          <div className="flex items-center justify-between px-1">
            <h1 className="text-base font-semibold">Чаты</h1>
            <div className="flex items-center gap-2">
              <CuratorOutreachButton
                available={outreachAvailable}
                onOpenConversation={setActiveId}
              />
              <span className="text-xs text-muted-foreground">
                {conversations.length}
                {totalUnread > 0 ? (
                  <span className="ml-1 text-primary">
                    · {totalUnread} новых
                  </span>
                ) : null}
              </span>
            </div>
          </div>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Поиск по диалогам…"
              className="pl-9"
              aria-label="Поиск по диалогам"
            />
          </div>
          {/* Сегмент-фильтр (все / непрочитанные) + сортировка */}
          <div className="flex items-center gap-2">
            <div className="flex flex-1 items-center gap-1 rounded-lg bg-muted p-0.5">
              {(
                [
                  ['all', 'Все'],
                  ['unread', 'Непрочитанные'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setFilter(value)}
                  className={cn(
                    'flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                    filter === value
                      ? 'bg-card text-foreground shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {label}
                  {value === 'unread' && totalUnread > 0 ? (
                    <span className="ml-1 tabular-nums">({totalUnread})</span>
                  ) : null}
                </button>
              ))}
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 shrink-0 gap-1.5 px-2.5 text-xs"
                  >
                    <ArrowDownUp className="size-3.5" />
                    <span className="hidden lg:inline">{SORT_LABELS[sort]}</span>
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="min-w-44">
                {(Object.keys(SORT_LABELS) as SortMode[]).map((mode) => (
                  <DropdownMenuItem key={mode} onClick={() => setSort(mode)}>
                    <Check
                      className={cn(
                        'size-4',
                        sort === mode ? 'opacity-100' : 'opacity-0',
                      )}
                    />
                    {SORT_LABELS[mode]}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {conversations.length === 0
                ? 'Переданных диалогов пока нет. Когда вам передадут лид с перепиской, он появится здесь.'
                : filter === 'unread'
                  ? 'Непрочитанных диалогов нет.'
                  : 'Ничего не найдено.'}
            </div>
          ) : (
            <ul className="p-1.5">
              {visible.map((c) => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  isActive={activeId === c.id}
                  leadStatus={leadStatusByConversation[c.id]}
                  onSelect={handleSelectConversation}
                />
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* -------------------------------- Тред ------------------------------- */}
      <section
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          activeId ? 'flex' : 'hidden md:flex',
        )}
      >
        {active ? (
          <CuratorThread
            key={active.id}
            active={active}
            activeId={activeId}
            leadStatus={leadStatusByConversation[active.id]}
            thread={thread}
            threadLoading={threadLoading}
            loadingOlder={loadingOlder}
            noOlder={noOlder}
            onLoadOlder={loadOlder}
            onBack={() => setActiveId(null)}
            actions={actions}
            forwardTargets={forwardTargets}
            infoOpen={infoOpen}
            onToggleInfo={() => setInfoOpen((v) => !v)}
            pending={pending}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageCircle className="size-10 opacity-40" />
            <p className="text-sm">Выберите диалог слева</p>
          </div>
        )}
      </section>

      {/* --------------------------- Инфо-панель ----------------------------- */}
      {active && infoOpen ? (
        <CuratorInfoPanel
          active={active}
          leadStatus={leadStatusByConversation[active.id]}
          onStatusSaved={onStatusSaved}
          onClose={() => setInfoOpen(false)}
        />
      ) : null}
    </div>
  )
}

function CuratorThread({
  active,
  activeId,
  leadStatus,
  thread,
  threadLoading,
  loadingOlder,
  noOlder,
  onLoadOlder,
  onBack,
  actions,
  forwardTargets,
  infoOpen,
  onToggleInfo,
  pending,
}: {
  active: Conversation
  activeId: string | null
  leadStatus?: CuratorConversationStatus
  thread: Message[]
  threadLoading: boolean
  loadingOlder: boolean
  noOlder: Record<string, boolean>
  onLoadOlder: () => void
  onBack: () => void
  actions: ReturnType<typeof useMessageActions>
  forwardTargets: ForwardTarget[]
  infoOpen: boolean
  onToggleInfo: () => void
  pending: boolean
}) {
  // Same battle-tested auto-scroll as the manager inbox: follow new messages
  // only while pinned to the bottom, so scrolling up to read history isn't
  // yanked back down when a new message arrives. Curator has no visitor-typing
  // preview, so activeTypingDraft is always empty.
  const { messagesScrollRef, handleThreadScroll } = useThreadScroll({
    activeId,
    threadLength: thread.length,
    activeTypingDraft: '',
  })
  const shellHeader = useShellHeader()
  // Персистентные черновики (как у менеджера): unsent-текст переживает смену
  // диалога, refresh и краш — зеркалится в localStorage. Ключ — id диалога.
  const { getDraft, persistDraft } = useDrafts()
  const channelShort =
    CHANNEL_VISUAL[active.channelType as PanelChannelType]?.short ??
    active.channelType

  // Шапка диалога уезжает в портал единственной шапки дашборда (назад + данные
  // лида + статус + сведения) — отдельной второй полосы под системной шапкой нет.
  const headerNode = (
    <div className="flex w-full min-w-0 items-center gap-2">
      <Button
        variant="ghost"
        size="icon"
        className="md:hidden"
        onClick={onBack}
        aria-label="Назад к списку"
      >
        <ArrowLeft className="size-4" />
      </Button>
      <ContactAvatar
        name={active.contactName}
        channel={active.channelType}
        channelId={active.channelId}
        conversationId={active.id}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold">
            {active.contactName}
          </span>
          {active.contactUsername ? (
            <span className="truncate text-xs text-muted-foreground">
              @{active.contactUsername}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{channelShort}</span>
          {active.channelName ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{active.channelName}</span>
            </>
          ) : null}
        </div>
      </div>
      {leadStatus ? (
        <LeadStatusBadge
          status={leadStatus.status}
          className="hidden shrink-0 sm:inline-flex"
        />
      ) : null}
      <Button
        variant={infoOpen ? 'secondary' : 'ghost'}
        size="icon"
        onClick={onToggleInfo}
        aria-label="Сведения о диалоге"
        aria-pressed={infoOpen}
      >
        <Info className="size-4" />
      </Button>
    </div>
  )

  return (
    <>
      {shellHeader?.slotEl
        ? createPortal(headerNode, shellHeader.slotEl)
        : null}

      {/* Лента + баннеры ответа/правки + композер — общее ядро с менеджером
          (components/shared/inbox/thread-pane). Менеджерские фичи (ИИ-гейт,
          быстрые ответы, Telemost) у куратора просто не передаются — дефолты
          композера описывают диалог, который ведёт человек. Тики доставки
          скрыты: доставка идёт под владельцем канала, «Не отправлено» вводило
          бы куратора в заблуждение. */}
      <ThreadPane
        active={active}
        activeId={activeId}
        thread={thread}
        threadLoading={threadLoading}
        loadingOlder={loadingOlder}
        noOlder={noOlder}
        onLoadOlder={onLoadOlder}
        forwardTargets={forwardTargets}
        messagesScrollRef={messagesScrollRef}
        onThreadScroll={handleThreadScroll}
        actions={actions}
        pending={pending}
        hideDeliveryStatus
        getInitialDraft={getDraft}
        onPersistDraft={persistDraft}
      />
    </>
  )
}
