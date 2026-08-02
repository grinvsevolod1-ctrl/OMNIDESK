'use client'

import { useCallback, useState, useTransition } from 'react'
import useSWR from 'swr'
import {
  ArrowLeft,
  ImageIcon,
  Loader2,
  MessageSquareText,
  Paperclip,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import { APP_TIME_ZONE } from '@/lib/time'
import { toast } from 'sonner'
import {
  getLeadTranscriptAction,
  listLeadsByStatusAction,
  setLeadStatusAction,
  type LeadTranscript,
} from '@/app/actions/leads'
import {
  LEAD_STATUS_META,
  LEAD_STATUS_OPTIONS,
  LEAD_STATUS_ORDER,
  NOT_LIQUID_REASON_META,
  NOT_LIQUID_REASON_ORDER,
  leadStatusOptionValue,
  type LeadStatus,
  type NotLiquidReason,
} from '@/lib/types'

const STATUS_ACCENT: Record<LeadStatus, { dot: string; bar: string }> = {
  unsubscribed: { dot: 'bg-sky-500', bar: 'bg-sky-500' },
  handoff: { dot: 'bg-amber-500', bar: 'bg-amber-500' },
  liquid: { dot: 'bg-teal-500', bar: 'bg-teal-500' },
  not_liquid: { dot: 'bg-muted-foreground', bar: 'bg-muted-foreground' },
  transferred: { dot: 'bg-emerald-500', bar: 'bg-emerald-500' },
}

const CHANNEL_LABEL: Record<string, string> = {
  telegram: 'Telegram',
  whatsapp: 'WhatsApp',
  livechat: 'Онлайн-чат',
  max: 'MAX',
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

type Selection = { status: LeadStatus; reason?: NotLiquidReason }

export function LeadStatusBoard({
  byStatus,
  byReason,
  total,
}: {
  byStatus: Record<LeadStatus, number>
  byReason: Record<NotLiquidReason, number>
  total: number
}) {
  const [selection, setSelection] = useState<Selection | null>(null)

  return (
    <Card className="p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h2 className="font-medium">Лиды по статусам</h2>
        <span className="text-xs text-muted-foreground">
          Нажмите на статус, чтобы открыть диалоги
        </span>
      </div>

      <div className="flex flex-col gap-2.5">
        {LEAD_STATUS_ORDER.map((status) => {
          const count = byStatus[status]
          const pct = total > 0 ? Math.round((count / total) * 100) : 0
          const accent = STATUS_ACCENT[status]
          return (
            <div key={status} className="flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => setSelection({ status })}
                className="group flex items-center gap-3 rounded-lg border border-transparent px-2 py-1.5 text-left transition-colors hover:border-border hover:bg-muted/50"
              >
                <span className={cn('size-2.5 rounded-full', accent.dot)} />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">
                      {LEAD_STATUS_META[status].label}
                    </span>
                    <span className="text-sm tabular-nums text-muted-foreground">
                      {count}
                      <span className="ml-1 text-xs">({pct}%)</span>
                    </span>
                  </span>
                  <span className="mt-1 block h-1.5 overflow-hidden rounded-full bg-muted">
                    <span
                      className={cn('block h-full rounded-full', accent.bar)}
                      style={{ width: `${pct}%` }}
                    />
                  </span>
                </span>
              </button>

              {/* «Не ликвид» reason sub-rows */}
              {status === 'not_liquid' && count > 0 ? (
                <div className="ml-5 flex flex-wrap gap-1.5">
                  {NOT_LIQUID_REASON_ORDER.map((reason) => {
                    const rc = byReason[reason]
                    if (rc === 0) return null
                    return (
                      <button
                        key={reason}
                        type="button"
                        onClick={() => setSelection({ status, reason })}
                        className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        {NOT_LIQUID_REASON_META[reason].label}
                        <span className="tabular-nums">{rc}</span>
                      </button>
                    )
                  })}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>

      <LeadBoardDialog
        selection={selection}
        open={selection !== null}
        onOpenChange={(o) => {
          if (!o) setSelection(null)
        }}
      />
    </Card>
  )
}

function LeadBoardDialog({
  selection,
  open,
  onOpenChange,
}: {
  selection: Selection | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<LeadTranscript | null>(null)
  const [transcriptLoading, setTranscriptLoading] = useState(false)
  const [mobileView, setMobileView] = useState<'list' | 'chat'>('list')
  const [pending, startTransition] = useTransition()

  const title = selection
    ? selection.reason
      ? `${LEAD_STATUS_META.not_liquid.label} · ${NOT_LIQUID_REASON_META[selection.reason].label}`
      : LEAD_STATUS_META[selection.status].label
    : ''

  // Load the bucket's conversations via SWR, keyed by the selected status +
  // reason, and only while the board is open. SWR dedupes/caches per bucket so
  // switching back to a previously opened bucket is instant.
  const {
    data: conversations = [],
    isLoading: listLoading,
    mutate: mutateList,
  } = useSWR(
    open && selection
      ? ['leads-by-status', selection.status, selection.reason ?? '']
      : null,
    ([, status, reason]) =>
      listLeadsByStatusAction(
        status as Selection['status'],
        (reason || null) as Selection['reason'],
      ),
    { revalidateOnFocus: false },
  )

  // Imperative refresh used after a status change moves a row out of the bucket.
  const loadList = useCallback(() => {
    void mutateList()
  }, [mutateList])

  const openConversation = useCallback((id: string) => {
    setSelectedId(id)
    setMobileView('chat')
    setTranscriptLoading(true)
    setTranscript(null)
    getLeadTranscriptAction(id)
      .then((data) => setTranscript(data))
      .finally(() => setTranscriptLoading(false))
  }, [])

  function changeStatus(conversationId: string, optionValue: string) {
    const opt = LEAD_STATUS_OPTIONS.find((o) => o.value === optionValue)
    if (!opt) return
    startTransition(async () => {
      const res = await setLeadStatusAction(
        conversationId,
        opt.status,
        opt.reason ?? null,
      )
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      // The conversation may have left the current bucket — refresh the list
      // and update the open transcript's status locally.
      loadList()
      setTranscript((prev) =>
        prev && prev.conversation
          ? {
              ...prev,
              conversation: {
                ...prev.conversation,
                status: opt.status,
                statusDetail: opt.reason,
                statusManual: true,
              },
            }
          : prev,
      )
    })
  }

  // Reset the transcript pane / selection when the board closes, so the next
  // open starts on the list view (the list itself comes from SWR cache).
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next) {
        setSelectedId(null)
        setTranscript(null)
        setMobileView('list')
      }
      onOpenChange(next)
    },
    [onOpenChange],
  )

  const activeConversation =
    transcript?.conversation ??
    conversations.find((c) => c.id === selectedId) ??
    null
  const currentValue = activeConversation
    ? leadStatusOptionValue(
        activeConversation.status,
        activeConversation.statusDetail,
      )
    : ''

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[85vh] max-h-[85vh] w-[min(64rem,calc(100%-2rem))] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
      >
        <DialogHeader className="border-b border-border px-5 py-4">
          <DialogTitle className="flex items-center gap-2">
            <MessageSquareText className="size-4 text-muted-foreground" />
            Лиды · {title}
            <span className="text-muted-foreground">
              ({conversations.length})
            </span>
          </DialogTitle>
          <DialogDescription>
            Просмотр диалогов, вложений и изменение статуса лида.
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
            <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
              {listLoading ? (
                <div className="flex h-full items-center justify-center py-10 text-muted-foreground">
                  <Loader2 className="size-5 animate-spin" />
                </div>
              ) : conversations.length === 0 ? (
                <p className="px-4 py-10 text-center text-sm text-muted-foreground">
                  В этом статусе пока нет диалогов.
                </p>
              ) : (
                <ul>
                  {conversations.map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => openConversation(c.id)}
                        className={cn(
                          'flex w-full flex-col gap-1 border-b border-border/60 px-4 py-3 text-left transition-colors hover:bg-muted/50',
                          selectedId === c.id && 'bg-muted',
                        )}
                      >
                        <span className="truncate text-sm font-medium">
                          {c.contactName || c.contactHandle}
                        </span>
                        <span className="truncate text-xs text-muted-foreground">
                          {c.lastMessage || 'Нет сообщений'}
                        </span>
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {CHANNEL_LABEL[c.channelType] ?? c.channelType}
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

          {/* Transcript + status editor */}
          <div
            className={cn(
              'flex min-h-0 w-full flex-1 flex-col bg-muted/20',
              mobileView === 'list' && 'hidden md:flex',
            )}
          >
            {!selectedId ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-muted-foreground">
                <MessageSquareText className="size-8" />
                <p className="text-sm">
                  Выберите диалог, чтобы прочитать переписку.
                </p>
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
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">
                      {activeConversation?.contactName ||
                        activeConversation?.contactHandle ||
                        'Диалог'}
                    </p>
                    {activeConversation ? (
                      <p className="truncate text-xs text-muted-foreground">
                        {CHANNEL_LABEL[activeConversation.channelType] ??
                          activeConversation.channelType}
                        {activeConversation.contactHandle
                          ? ` · ${activeConversation.contactHandle}`
                          : ''}
                      </p>
                    ) : null}
                  </div>
                </div>

                {/* Status editor */}
                <div className="border-b border-border bg-card/60 px-4 py-3">
                  <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    Статус лида
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {LEAD_STATUS_OPTIONS.map((opt) => {
                      const active = currentValue === opt.value
                      return (
                        <button
                          key={opt.value}
                          type="button"
                          disabled={pending || !selectedId}
                          onClick={() =>
                            selectedId && changeStatus(selectedId, opt.value)
                          }
                          className={cn(
                            'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                            active
                              ? 'border-foreground/20 bg-background text-foreground shadow-sm'
                              : 'border-transparent bg-muted/60 text-muted-foreground hover:bg-muted',
                          )}
                        >
                          <span
                            className={cn(
                              'size-1.5 rounded-full',
                              STATUS_ACCENT[opt.status].dot,
                            )}
                          />
                          {opt.label}
                        </button>
                      )
                    })}
                    {pending ? (
                      <Loader2 className="size-4 animate-spin self-center text-muted-foreground" />
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
                      const isImage = m.mediaType === 'image'
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
                            {isImage && m.mediaUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={m.mediaUrl || '/placeholder.svg'}
                                alt={m.mediaName || 'Вложение'}
                                className="mb-1 max-h-60 rounded-lg object-cover"
                                crossOrigin="anonymous"
                                loading="lazy"
                                decoding="async"
                              />
                            ) : m.mediaType ? (
                              <span className="mb-1 flex items-center gap-1.5 text-xs opacity-80">
                                {m.mediaType === 'image' ? (
                                  <ImageIcon className="size-3.5" />
                                ) : (
                                  <Paperclip className="size-3.5" />
                                )}
                                Вложение
                                {m.mediaName
                                  ? `: ${m.mediaName}`
                                  : ` (${m.mediaType})`}
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
