'use client'

/**
 * Раздел «Диалоги» руководителя (/head/chats): переписка кураторов его
 * команд(ы) с кандидатами — ТОЛЬКО ПРОСМОТР. Слева: выбор куратора, поиск
 * кандидата, список диалогов; справа: полная история треда на общем ядре
 * инбокса (ThreadPane в режиме viewOnly — без ответа, правки, реакций и
 * удаления; композер заменён плашкой). Новые сообщения появляются живьём
 * через тот же /api/stream (события кураторов команды). Из шапки треда
 * доступна выгрузка диалога файлом (HTML / ZIP с медиа).
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { ArrowLeft, Download, Eye, MessageCircle, Search, Users } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import type { Conversation, Message, PanelChannelType } from '@/lib/types'
import { ContactAvatar } from '@/components/manager/inbox/atoms'
import { useThreadScroll } from '@/components/manager/inbox/use-thread-scroll'
import { CHANNEL_VISUAL } from '@/components/manager/inbox/visual'
import { ThreadPane } from '@/components/shared/inbox/thread-pane'
import { DialogExportDialog } from '@/components/shared/inbox/dialog-export-dialog'
import type { useMessageActions } from '@/components/shared/inbox/use-message-actions'
import { useShellHeader } from '@/components/dashboard-shell'
import { HeadConversationRow } from './head-conversation-row'
import { useHeadChats } from './use-head-chats'

export interface HeadChatCurator {
  id: string
  name: string
  /** Сколько диалогов этого куратора в списке (считается на сервере). */
  dialogs: number
}

const ALL_CURATORS = '__all__'

export function HeadChats({
  curators,
  conversations,
  messagesByConversation,
  currentUser,
}: {
  curators: HeadChatCurator[]
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  currentUser: string
}) {
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
    pending,
  } = useHeadChats({ conversations, messagesByConversation, currentUser })

  const [curatorId, setCuratorId] = useState<string>(ALL_CURATORS)
  const [search, setSearch] = useState('')

  const shellHeader = useShellHeader()
  useEffect(() => {
    shellHeader?.setThreadOpen(Boolean(active))
    return () => shellHeader?.setThreadOpen(false)
  }, [active, shellHeader])

  // Фильтр по куратору + поиск кандидата (имя / ник / последнее сообщение).
  // Список уже отсортирован сервером «свежие сверху».
  const visible = useMemo(() => {
    const q = search.trim().toLowerCase()
    return conversations.filter((c) => {
      if (curatorId !== ALL_CURATORS && c.curatorId !== curatorId) return false
      if (!q) return true
      return (
        c.contactName.toLowerCase().includes(q) ||
        (c.contactUsername ?? '').toLowerCase().includes(q) ||
        (c.lastMessage ?? '').toLowerCase().includes(q)
      )
    })
  }, [conversations, curatorId, search])

  const handleSelectConversation = useCallback(
    (id: string) => setActiveId(id),
    [setActiveId],
  )

  const selectedCurator = curators.find((c) => c.id === curatorId) ?? null

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
            <h1 className="text-base font-semibold">Диалоги кураторов</h1>
            <span className="text-xs text-muted-foreground tabular-nums">
              {visible.length}
              {visible.length !== conversations.length
                ? ` из ${conversations.length}`
                : ''}
            </span>
          </div>

          <Select
            value={curatorId}
            onValueChange={(v) => setCuratorId(v ?? ALL_CURATORS)}
          >
            <SelectTrigger className="h-9 w-full" aria-label="Куратор">
              <Users className="size-4 shrink-0 text-muted-foreground" />
              <SelectValue placeholder="Все кураторы" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CURATORS}>
                Все кураторы ({conversations.length})
              </SelectItem>
              {curators.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} ({c.dialogs})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Найти кандидата…"
              className="h-9 pl-9"
              aria-label="Поиск кандидата"
            />
          </div>
        </div>

        <div className="scrollbar-thin flex-1 overflow-y-auto">
          {visible.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              {conversations.length === 0
                ? curators.length === 0
                  ? 'В вашей команде пока нет кураторов.'
                  : 'У кураторов вашей команды пока нет переданных диалогов.'
                : search.trim()
                  ? 'Ничего не найдено.'
                  : selectedCurator
                    ? `У ${selectedCurator.name} пока нет диалогов.`
                    : 'Ничего не найдено.'}
            </div>
          ) : (
            <ul className="p-1.5">
              {visible.map((c) => (
                <HeadConversationRow
                  key={c.id}
                  conversation={c}
                  isActive={activeId === c.id}
                  showCurator={curatorId === ALL_CURATORS}
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
          <HeadThread
            key={active.id}
            active={active}
            activeId={activeId}
            thread={thread}
            threadLoading={threadLoading}
            loadingOlder={loadingOlder}
            noOlder={noOlder}
            onLoadOlder={loadOlder}
            onBack={() => setActiveId(null)}
            actions={actions}
            pending={pending}
          />
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
            <MessageCircle className="size-10 opacity-40" />
            <p className="text-sm">
              Выберите куратора и диалог слева, чтобы открыть переписку
            </p>
            <p className="max-w-xs text-xs">
              Просмотр без возможности писать от имени куратора. Новые
              сообщения появляются автоматически.
            </p>
          </div>
        )}
      </section>
    </div>
  )
}

function HeadThread({
  active,
  activeId,
  thread,
  threadLoading,
  loadingOlder,
  noOlder,
  onLoadOlder,
  onBack,
  actions,
  pending,
}: {
  active: Conversation
  activeId: string | null
  thread: Message[]
  threadLoading: boolean
  loadingOlder: boolean
  noOlder: Record<string, boolean>
  onLoadOlder: () => void
  onBack: () => void
  actions: ReturnType<typeof useMessageActions>
  pending: boolean
}) {
  const { messagesScrollRef, handleThreadScroll } = useThreadScroll({
    activeId,
    threadLength: thread.length,
    activeTypingDraft: '',
  })
  const shellHeader = useShellHeader()
  const [exportOpen, setExportOpen] = useState(false)
  const channelShort =
    CHANNEL_VISUAL[active.channelType as PanelChannelType]?.short ??
    active.channelType

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
          {active.curatorName ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">Ведёт: {active.curatorName}</span>
            </>
          ) : null}
        </div>
      </div>
      <span className="hidden shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground sm:inline-flex">
        <Eye className="size-3" />
        Просмотр
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setExportOpen(true)}
        aria-label="Выгрузить диалог файлом"
        title="Выгрузить диалог"
      >
        <Download className="size-4" />
      </Button>
    </div>
  )

  return (
    <>
      {shellHeader?.slotEl
        ? createPortal(headerNode, shellHeader.slotEl)
        : null}

      <DialogExportDialog
        conversation={active}
        open={exportOpen}
        onOpenChange={setExportOpen}
      />

      <ThreadPane
        active={active}
        activeId={activeId}
        thread={thread}
        threadLoading={threadLoading}
        loadingOlder={loadingOlder}
        noOlder={noOlder}
        onLoadOlder={onLoadOlder}
        forwardTargets={[]}
        messagesScrollRef={messagesScrollRef}
        onThreadScroll={handleThreadScroll}
        actions={actions}
        pending={pending}
        hideDeliveryStatus
        viewOnly
        getInitialDraft={noDraft}
        onPersistDraft={noop}
        composerReplacement={
          <div className="flex items-center justify-center gap-2 border-t border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
            <Eye className="size-3.5 shrink-0" />
            <span>
              Только просмотр. Писать, править и удалять сообщения от имени
              куратора нельзя.
            </span>
          </div>
        }
      />
    </>
  )
}

function noDraft(): string {
  return ''
}

function noop(): void {}
