'use client'

import { useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  addLeadCommentAction,
  getLeadCardDetailAction,
} from '@/app/actions/lead-cards'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { LeadAttachments } from '@/components/shared/lead-attachments'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { leadStatusLabel } from '@/lib/lead-status'
import { APP_TIME_ZONE } from '@/lib/time'
import { cn } from '@/lib/utils'

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

/**
 * Карточка лида глазами менеджера: статус и история от менеджера по кадрам,
 * общие комментарии и вложения (фото/видео/кружки). Менеджер может
 * добавлять комментарии и файлы, но не менять статус — это зона менеджера по кадрам.
 */
export function ManagerLeadDetailPanel({
  leadId,
  onClose,
}: {
  leadId: string
  onClose: () => void
}) {
  const [freeComment, setFreeComment] = useState('')
  const [pending, startTransition] = useTransition()

  const {
    data: detail,
    isLoading: loading,
    mutate,
  } = useSWR(
    ['manager-lead-detail', leadId],
    () => getLeadCardDetailAction(leadId),
    { revalidateOnFocus: false },
  )
  const card = detail?.card ?? null
  const comments = detail?.comments ?? []
  const statusHistory = detail?.statusHistory ?? []

  function saveFreeComment() {
    if (!freeComment.trim()) return
    startTransition(async () => {
      const res = await addLeadCommentAction({
        leadCardId: leadId,
        body: freeComment,
      })
      if (res.ok) {
        toast.success(res.message)
        setFreeComment('')
        await mutate()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/30 supports-backdrop-filter:backdrop-blur-[2px]"
        aria-label="Закрыть"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 flex h-full w-full flex-col bg-popover shadow-2xl ring-1 ring-foreground/10',
          'animate-in slide-in-from-bottom-4 duration-200 sm:slide-in-from-right-4',
          'max-sm:mt-auto max-sm:h-[min(94dvh,100%)] max-sm:rounded-t-2xl',
          'sm:w-[min(32rem,100vw)]',
        )}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-5">
          <p className="text-sm font-semibold">Карточка лида</p>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </Button>
        </header>

        {loading || !card ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Загрузка…
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:px-5">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">
                  {card.fullName || 'Без имени'}
                </h2>
                {card.vacancy ? (
                  <p className="text-sm text-muted-foreground">
                    {card.vacancy}
                  </p>
                ) : null}
                <div className="mt-2">
                  <LeadStatusBadge
                    status={card.status}
                    previousStatus={card.previousStatus}
                  />
                </div>
              </div>

              <dl className="grid gap-2.5 text-sm sm:grid-cols-2">
                {card.phone ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">Телефон</dt>
                    <dd className="font-medium">{card.phone}</dd>
                  </div>
                ) : null}
                {card.telegramUsername ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">Telegram</dt>
                    <dd className="font-medium">@{card.telegramUsername}</dd>
                  </div>
                ) : null}
                {card.city ? (
                  <div>
                    <dt className="text-xs text-muted-foreground">Город</dt>
                    <dd className="font-medium">{card.city}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-muted-foreground">Менеджер по кадрам</dt>
                  <dd className="font-medium">{card.curatorName ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Передан</dt>
                  <dd className="font-medium">
                    {card.transferredAt
                      ? formatDateTime(card.transferredAt)
                      : 'Не передан'}
                  </dd>
                </div>
              </dl>

              {statusHistory.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    История статусов менеджера по кадрам
                  </p>
                  <ul className="flex flex-col gap-1">
                    {statusHistory.slice(0, 10).map((h) => (
                      <li
                        key={h.id}
                        className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                      >
                        <span>{formatDateTime(h.createdAt)}</span>
                        {h.reason === 'transfer_reset' ? (
                          <span className="rounded bg-muted px-1 py-0.5 text-[10px]">
                            сброс при передаче
                          </span>
                        ) : h.status ? (
                          <LeadStatusBadge status={h.status} />
                        ) : null}
                        {h.curatorName ? <span>— {h.curatorName}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {/* Файлы: фото/видео + кружки из диалога */}
            <div className="border-b border-border px-4 py-4 sm:px-5">
              <LeadAttachments
                leadCardId={leadId}
                conversationId={card.conversationId}
                attachments={detail?.attachments ?? []}
                onChanged={() => void mutate()}
              />
            </div>

            {/* Комментарии: менеджер видит комментарии менеджера по кадрам и пишет свои */}
            <div className="flex flex-col gap-3 px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold">Комментарии</p>
              <div className="flex flex-col gap-2">
                <Textarea
                  value={freeComment}
                  onChange={(e) => setFreeComment(e.target.value)}
                  placeholder="Комментарий по лиду (виден менеджеру по кадрам и админу)…"
                  rows={2}
                />
                <Button
                  variant="outline"
                  size="sm"
                  className="self-start"
                  disabled={pending || !freeComment.trim()}
                  onClick={saveFreeComment}
                >
                  Добавить комментарий
                </Button>
              </div>
              {comments.length === 0 ? (
                <p className="text-sm text-muted-foreground">Пока пусто</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {comments.map((c) => (
                    <li
                      key={c.id}
                      className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
                    >
                      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">
                          {c.authorName ?? '—'}
                        </span>
                        {c.status ? (
                          <Badge
                            variant="outline"
                            className="border-transparent bg-background text-[10px]"
                          >
                            {leadStatusLabel(c.status)}
                          </Badge>
                        ) : null}
                        <span className="ml-auto">
                          {formatDateTime(c.createdAt)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap text-sm leading-relaxed">
                        {c.body}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
