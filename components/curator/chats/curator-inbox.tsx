'use client'

/**
 * Раздел «Чаты» куратора: список переданных диалогов + тред + композер.
 * Полноэкранная раскладка (dashboard-shell отдаёт /curator/chats как fullBleed,
 * без полей и внешнего скролла — как менеджерский инбокс). Тред и композер
 * переиспуют РОВНО те же компоненты, что и у менеджера (MessageList +
 * MessageComposer): куратору доступен полный набор действий — ответ, копия,
 * реакции, редактирование своих, удаление, пересылка, стикеры, голосовые и
 * отложенная отправка. Все серверные экшены скоуплены по curator_id (см.
 * app/actions/curator-messages). Состояние — в use-curator-chats, здесь только
 * вёрстка и локальный UI-стейт панелей.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  ArrowLeft,
  ArrowDownUp,
  CalendarClock,
  Check,
  Info,
  MessageCircle,
  Pencil,
  Radio,
  Reply,
  Search,
  X,
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
import type { Conversation, Message, StickerItem } from '@/lib/types'
import { ContactAvatar, MetaRows, SourceChip } from '@/components/manager/inbox/atoms'
import { MessageList } from '@/components/manager/inbox/message-list'
import { MessageComposer } from '@/components/manager/inbox/message-composer'
import { CHANNEL_VISUAL, listStamp } from '@/components/manager/inbox/visual'
import type { ForwardTarget } from '@/components/manager/message-context-menu'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { LeadStatusForm } from '@/components/curator/lead-panel-forms'
import { CuratorOutreachButton } from '@/components/curator/chats/curator-outreach'
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

/**
 * Строка списка диалогов. Мемоизирована: раньше все строки перерисовывались на
 * каждый рендер родителя (ввод в поиск, realtime-события, router.refresh) —
 * при сотнях диалогов это и давало «лаги». Теперь строка ре-рендерится только
 * при смене своих пропсов, а onSelect — стабильная ссылка из родителя.
 */
const ConversationRow = memo(function ConversationRow({
  conversation: c,
  isActive,
  leadStatus,
  onSelect,
}: {
  conversation: Conversation
  isActive: boolean
  leadStatus?: CuratorConversationStatus
  onSelect: (id: string) => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        className={cn(
          'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors',
          isActive
            ? 'bg-primary/10 ring-1 ring-primary/30'
            : 'hover:bg-muted/60',
        )}
      >
        <ContactAvatar
          name={c.contactName}
          channel={c.channelType}
          channelId={c.channelId}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span
              className={cn(
                'truncate text-sm',
                c.unread > 0 ? 'font-semibold text-foreground' : 'font-medium',
              )}
            >
              {c.contactName}
            </span>
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {listStamp(c.lastMessageAt)}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-1.5">
            <SourceChip conversation={c} size="xs" />
            <span
              className={cn(
                'truncate text-xs',
                c.unread > 0 ? 'text-foreground/80' : 'text-muted-foreground',
              )}
            >
              {c.lastMessage || '—'}
            </span>
          </div>
          {leadStatus ? (
            <div className="mt-1">
              <LeadStatusBadge
                status={leadStatus.status}
                className="px-1.5 py-0 text-[10px]"
              />
            </div>
          ) : null}
        </div>
        {c.unread > 0 ? (
          <span className="ml-1 flex size-5 shrink-0 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground tabular-nums">
            {c.unread > 99 ? '99+' : c.unread}
          </span>
        ) : null}
      </button>
    </li>
  )
})

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
    handleSend,
    handleSendMediaFile,
    replyTarget,
    setReplyTarget,
    editTarget,
    setEditTarget,
    handleReply,
    handleEdit,
    handleCopy,
    reactTo,
    deleteMessage,
    forwardMessage,
    forwardTargets,
    sendSticker,
    sendVoice,
    scheduleSend,
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
            onSend={handleSend}
            onSendMediaFile={handleSendMediaFile}
            onSendSticker={sendSticker}
            onSendVoice={sendVoice}
            onScheduleSend={scheduleSend}
            onReply={handleReply}
            onEdit={handleEdit}
            onReact={reactTo}
            onDelete={deleteMessage}
            onForward={forwardMessage}
            forwardTargets={forwardTargets}
            onCopy={handleCopy}
            replyTarget={replyTarget}
            onCancelReply={() => setReplyTarget(null)}
            editTarget={editTarget}
            onCancelEdit={() => setEditTarget(null)}
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
  onSend,
  onSendMediaFile,
  onSendSticker,
  onSendVoice,
  onScheduleSend,
  onReply,
  onEdit,
  onReact,
  onDelete,
  onForward,
  forwardTargets,
  onCopy,
  replyTarget,
  onCancelReply,
  editTarget,
  onCancelEdit,
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
  onSend: (text: string) => void
  onSendMediaFile: (file: File, caption: string) => void
  onSendSticker: (sticker: StickerItem) => void
  onSendVoice: (audio: {
    base64: string
    mime: string
    durationSec: number
  }) => void
  onScheduleSend: (text: string, scheduleAtIso: string) => void
  onReply: (m: Message) => void
  onEdit: (m: Message) => void
  onReact: (m: Message, emoji: string) => void
  onDelete: (m: Message) => void
  onForward: (m: Message, toConversationId: string) => void
  forwardTargets: ForwardTarget[]
  onCopy: (m: Message) => void
  replyTarget: Message | null
  onCancelReply: () => void
  editTarget: Message | null
  onCancelEdit: () => void
  infoOpen: boolean
  onToggleInfo: () => void
  pending: boolean
}) {
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)
  const shellHeader = useShellHeader()
  // Персистентные черновики (как у менеджера): unsent-текст переживает смену
  // диалога, refresh и краш — зеркалится в localStorage. Ключ — id диалога.
  const { getDraft, persistDraft } = useDrafts()
  const channelShort =
    CHANNEL_VISUAL[active.channelType as PanelChannelType]?.short ??
    active.channelType

  // Автопрокрутка вниз при открытии диалога и приходе нового последнего
  // сообщения. Ключуемся на id последнего сообщения — подгрузка старой истории
  // (меняет первый, не последний) прокрутку не дёргает.
  const lastId = thread.length ? thread[thread.length - 1].id : null
  useEffect(() => {
    const el = messagesScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [activeId, lastId])

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

      {/* Лента — богатый MessageList менеджера в режиме read-only-действий */}
      {threadLoading && thread.length === 0 ? (
        <div className="flex flex-1 items-center justify-center bg-muted/20 text-sm text-muted-foreground">
          Загрузка переписки…
        </div>
      ) : thread.length === 0 ? (
        <div className="flex flex-1 items-center justify-center bg-muted/20 text-sm text-muted-foreground">
          Сообщений пока нет.
        </div>
      ) : (
        <MessageList
          active={active}
          activeId={activeId}
          thread={thread}
          threadLoading={threadLoading}
          noOlder={noOlder}
          loadingOlder={loadingOlder}
          onLoadOlder={onLoadOlder}
          forwardTargets={forwardTargets}
          activeTyping={null}
          messagesScrollRef={messagesScrollRef}
          onThreadScroll={() => {}}
          onReply={onReply}
          onEdit={onEdit}
          onReact={onReact}
          onCopy={onCopy}
          onForward={onForward}
          onDelete={onDelete}
          onShowHistory={() => {}}
          hideDeliveryStatus
        />
      )}

      {/* Баннер редактирования — взаимоисключим с цитатой (как у менеджера) */}
      {editTarget ? (
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2 sm:px-4">
          <Pencil className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
            <p className="truncate text-xs font-semibold text-foreground">
              Редактирование
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {editTarget.body || '[сообщение]'}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onCancelEdit}
            aria-label="Отменить редактирование"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : replyTarget ? (
        <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2 sm:px-4">
          <Reply className="size-4 shrink-0 text-primary" />
          <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
            <p className="truncate text-xs font-semibold text-foreground">
              {replyTarget.author || 'Сообщение'}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {replyTarget.body ||
                (replyTarget.mediaType ? '[вложение]' : '')}
            </p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-7 shrink-0"
            onClick={onCancelReply}
            aria-label="Отменить ответ"
          >
            <X className="size-4" />
          </Button>
        </div>
      ) : null}

      {/* Композер — ровно тот же, что у менеджера. Менеджерские фичи, которых
          у куратора нет, нейтрализованы: ИИ всегда выключен (диалог уже передан
          человеку), быстрых ответов и Telemost нет. Стикеры/голос/отложка/эмодзи
          работают через кураторские экшены. */}
      <MessageComposer
        conversationId={active.id}
        channelType={active.channelType}
        channelId={active.channelId}
        getInitialDraft={(id) => getDraft(id)}
        onPersistDraft={(t) => persistDraft(active.id, t)}
        onSend={onSend}
        onSendSticker={onSendSticker}
        onSendMediaFile={onSendMediaFile}
        onSendVoice={onSendVoice}
        onVoiceError={(m) => toast.error(m)}
        onScheduleSend={onScheduleSend}
        aiLed={false}
        onBlockedInteract={() => {}}
        onToggleAi={() => {}}
        statusPending={false}
        pending={pending}
        quickReplies={[]}
        telemostEnabled={false}
        onStartMeeting={() => {}}
        meetingPending={false}
        replyActive={Boolean(replyTarget)}
        editing={
          editTarget ? { id: editTarget.id, body: editTarget.body ?? '' } : null
        }
      />
    </>
  )
}

function CuratorInfoPanel({
  active,
  leadStatus,
  onStatusSaved,
  onClose,
}: {
  active: Conversation
  leadStatus?: CuratorConversationStatus
  onStatusSaved: () => void
  onClose: () => void
}) {
  const channelShort =
    CHANNEL_VISUAL[active.channelType as PanelChannelType]?.short ??
    active.channelType
  const rows: { icon: typeof Radio; label: string; value: string }[] = []
  rows.push({ icon: Radio, label: 'Канал', value: channelShort })
  if (active.channelName)
    rows.push({ icon: Radio, label: 'Источник', value: active.channelName })
  if (active.transferredToCuratorAt)
    rows.push({
      icon: CalendarClock,
      label: 'Передан вам',
      value: listStamp(active.transferredToCuratorAt),
    })

  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full max-w-sm flex-col border-l border-border bg-card shadow-xl md:static md:z-auto md:w-80 md:shadow-none lg:w-[22rem]">
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Сведения</h2>
        <Button
          variant="ghost"
          size="icon"
          onClick={onClose}
          aria-label="Закрыть сведения"
        >
          <X className="size-4" />
        </Button>
      </header>
      <div className="scrollbar-thin flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-2 pb-4 text-center">
          <ContactAvatar
            name={active.contactName}
            channel={active.channelType}
            channelId={active.channelId}
            size="lg"
          />
          <div>
            <p className="text-sm font-semibold">{active.contactName}</p>
            {active.contactUsername ? (
              <p className="text-xs text-muted-foreground">
                @{active.contactUsername}
              </p>
            ) : null}
          </div>
          {leadStatus ? (
            <LeadStatusBadge status={leadStatus.status} />
          ) : null}
        </div>

        <dl className="flex flex-col gap-3 border-t border-border pt-4">
          {rows.map((r, i) => (
            <div key={i} className="flex items-start gap-2.5 text-xs">
              <r.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="min-w-0">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="font-medium text-foreground">{r.value}</dd>
              </div>
            </div>
          ))}
        </dl>

        {/* Кураторский статус лида: свой набор статусов + обязательный
            комментарий. Тот же action и форма, что и в «Мои лиды» — куратор
            подтверждает статус, не выходя из переписки. -mx-4 распахивает
            секцию на всю ширину панели (форма имеет собственные поля px-4). */}
        {leadStatus ? (
          <div className="-mx-4 mt-4 border-t border-border">
            <LeadStatusForm
              leadCardId={leadStatus.leadCardId}
              currentStatus={leadStatus.status}
              onSaved={onStatusSaved}
              variant="curator"
            />
          </div>
        ) : null}

        {/* Контекст посетителя (лайв-чат сайта) */}
        {active.meta ? (
          <div className="mt-4 border-t border-border pt-4">
            <p className="mb-3 text-xs font-semibold text-muted-foreground">
              Посетитель сайта
            </p>
            <MetaRows meta={active.meta} />
          </div>
        ) : null}
      </div>
    </aside>
  )
}
