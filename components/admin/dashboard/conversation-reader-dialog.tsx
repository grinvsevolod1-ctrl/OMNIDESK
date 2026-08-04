'use client'

import { useCallback, useState } from 'react'
import useSWR from 'swr'
import {
  ArrowLeft,
  Loader2,
  MessageSquareText,
  Paperclip,
  Search,
} from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { APP_TIME_ZONE } from '@/lib/time'
import {
  adminGetTranscriptAction,
  adminListManagerConversationsAction,
  type AdminTranscript,
} from '@/app/actions/admin-inbox'
import type { LeadStatus } from '@/lib/types'
import {
  useChannelTypeLabels,
  useLeadStatusMeta,
} from '@/components/dictionaries-provider'

const STATUS_DOT: Record<LeadStatus, string> = {
  unsubscribed: 'bg-sky-500',
  handoff: 'bg-amber-500',
  liquid: 'bg-teal-500',
  not_liquid: 'bg-muted-foreground',
  transferred: 'bg-emerald-500',
}

function formatTime(iso: string): string {
  // Always MSK, regardless of the viewer's timezone.
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

export function ConversationReaderDialog({
  managerId,
  managerName,
  open,
  onOpenChange,
}: {
  managerId: string | null
  managerName: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const leadStatuses = useLeadStatusMeta()
  const channelLabels = useChannelTypeLabels()
  const [search, setSearch] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<AdminTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list')

  // Load the manager's conversation list via SWR — only while the dialog is
  // open (key is null otherwise, so it stays idle). SWR caches per manager, so
  // reopening the same manager renders instantly without a refetch.
  const { data: conversations = [], isLoading: listLoading } = useSWR(
    open && managerId ? ['admin-manager-conversations', managerId] : null,
    ([, id]) => adminListManagerConversationsAction(id),
    { revalidateOnFocus: false },
  )

  // Reset the transcript pane / filters each time the dialog is closed so the
  // next open starts clean (the list itself is served from SWR cache).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelectedId(null)
        setTranscript(null)
        setSearch('')
        setMobileView('list')
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const openConversation = useCallback((id: string) => {
    setSelectedId(id)
    setMobileView('chat')
    setTranscriptLoading(true)
    setTranscript(null)
    adminGetTranscriptAction(id)
      .then((data) => setTranscript(data))
      .finally(() => setTranscriptLoading(false))
  }, [])

  const filtered = conversations.filter((c) => {
    if (!search.trim()) return true
    const q = search.toLowerCase()
    return (
      c.contactName.toLowerCase().includes(q) ||
      c.contactHandle.toLowerCase().includes(q) ||
      c.lastMessage.toLowerCase().includes(q)
    )
  })

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        /* Override the base `sm:max-w-sm` cap (it otherwise wins over a plain
           max-w-* at ≥640px and squishes the two-pane layout). Size the modal
           explicitly so the transcript pane stays readable on wide screens. */
        className="flex h-[85vh] max-h-[85vh] w-[min(64rem,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-muted-foreground" />
            Диалоги менеджера
            {managerName ? (
              <span className="text-muted-foreground">· {managerName}</span>
            ) : null}
          </DialogTitle>
          <DialogDescription>
            Просмотр переписок только для чтения. Отправка сообщений недоступна
            в режиме руководителя.
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1">
          {/* Conversation list */}
          <div
            className={cn(
              'flex w-full flex-col border-r border-border md:w-72 md:shrink-0',
              mobileView === 'chat' && 'hidden md:flex',
            )}
          >
            <div className="border-b border-border p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по диалогам"
                  className="h-9 rounded-lg pl-9 text-sm"
                  aria-label="Поиск по диалогам"
                />
              </div>
            </div>
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
              {listLoading ? (
                <div className="flex h-full items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : filtered.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  {conversations.length === 0
                    ? 'У этого менеджера пока нет диалогов.'
                    : 'Ничего не найдено.'}
                </p>
              ) : (
                <ul>
                  {filtered.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => openConversation(c.id)}
                        className={cn(
                          'flex w-full flex-col gap-1 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                          selectedId === c.id && 'bg-muted',
                        )}
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate text-sm font-medium">
                            {c.contactName || c.contactHandle}
                          </span>
                          <span
                            className={cn(
                              'size-2 shrink-0 rounded-full',
                              STATUS_DOT[c.status],
                            )}
                            title={leadStatuses[c.status].label}
                            aria-hidden
                          />
                        </div>
                        <span className="truncate text-xs text-muted-foreground">
                          {c.lastMessage || 'Нет сообщений'}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {channelLabels[c.channelType] ?? c.channelType}
                          {' · '}
                          {formatTime(c.lastMessageAt)}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* Transcript */}
          <div
            className={cn(
              'flex min-h-0 w-full flex-1 flex-col bg-muted/20',
              mobileView === 'list' && 'hidden md:flex',
            )}
          >
            {!selectedId ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                <MessageSquareText className="size-8" />
                <p className="text-sm">Выберите диалог, чтобы прочитать переписку.</p>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-2 border-b border-border bg-card px-4 py-3">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="md:hidden"
                    onClick={() => setMobileView('list')}
                    aria-label="Назад к списку"
                  >
                    <ArrowLeft className="size-4" />
                  </Button>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {transcript?.conversation?.contactName ||
                        transcript?.conversation?.contactHandle ||
                        'Диалог'}
                    </p>
                    {transcript?.conversation ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {channelLabels[transcript.conversation.channelType] ??
                          transcript.conversation.channelType}
                        {transcript.conversation.contactHandle
                          ? ` · ${transcript.conversation.contactHandle}`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                </div>

                <div className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4">
                  {transcriptLoading ? (
                    <div className="flex h-full items-center justify-center text-muted-foreground">
                      <Loader2 className="size-5 animate-spin" />
                    </div>
                  ) : !transcript || transcript.messages.length === 0 ? (
                    <p className="py-10 text-center text-sm text-muted-foreground">
                      В этом диалоге пока нет сообщений.
                    </p>
                  ) : (
                    transcript.messages.map((m) => {
                      const out = m.direction === 'out'
                      return (
                        <div
                          key={m.id}
                          className={cn(
                            'flex flex-col',
                            out ? 'items-end' : 'items-start',
                          )}
                        >
                          <div
                            className={cn(
                              'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm',
                              out
                                ? 'rounded-br-sm bg-primary text-primary-foreground'
                                : 'rounded-bl-sm bg-card text-card-foreground ring-1 ring-border',
                            )}
                          >
                            {m.mediaType ? (
                              <span className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
                                <Paperclip className="size-3.5" />
                                Вложение
                                {m.mediaName ? `: ${m.mediaName}` : ` (${m.mediaType})`}
                              </span>
                            ) : null}
                            {m.body ? (
                              <p className="whitespace-pre-wrap break-words leading-relaxed">
                                {m.body}
                              </p>
                            ) : null}
                          </div>
                          <span className="mt-1 px-1 text-[10px] text-muted-foreground">
                            {m.author} · {formatTime(m.createdAt)}
                          </span>
                        </div>
                      )
                    })
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
