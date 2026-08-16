'use client'

import { useMemo, useState, useTransition } from 'react'
import { SearchX } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  addLeadCommentAction,
  getLeadCardDetailAction,
} from '@/app/actions/lead-cards'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { LeadAttachments } from '@/components/shared/lead-attachments'
import { LeadHistoryEvent } from '@/components/shared/lead-history-event'
import {
  SlideOver,
  SlideOverSectionSkeleton,
} from '@/components/shared/slide-over'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import type { LeadCard } from '@/lib/data/lead-cards'
import { leadStatusLabel } from '@/lib/lead-status'
import { formatMskDateTimeFull as formatDateTime } from '@/lib/time'

type LeadCardDetail = NonNullable<
  Awaited<ReturnType<typeof getLeadCardDetailAction>>
>
type PartialDetail = LeadCardDetail & { partial?: true }

/**
 * Карточка лида глазами менеджера: статус и история от менеджера по кадрам,
 * общие комментарии и вложения (фото/видео/кружки). Менеджер может
 * добавлять комментарии и файлы, но не менять статус — это зона менеджера по кадрам.
 *
 * Использует общий SlideOver (transform-only анимация, панель всегда
 * смонтирована) и мгновенный первый кадр из строки списка (fallbackLead).
 */
export function ManagerLeadDetailPanel({
  leadId,
  fallbackLead,
  onClose,
}: {
  leadId: string | null
  /** Карточка из строки списка — рендерится мгновенно, без ожидания сети. */
  fallbackLead?: LeadCard | null
  onClose: () => void
}) {
  const [freeComment, setFreeComment] = useState('')
  const [pending, startTransition] = useTransition()

  // Последний открытый id — контент виден во время анимации закрытия.
  const [lastId, setLastId] = useState(leadId)
  if (leadId && leadId !== lastId) {
    setLastId(leadId)
    setFreeComment('')
  }
  const activeId = leadId ?? lastId

  const fallbackDetail = useMemo<PartialDetail | undefined>(
    () =>
      fallbackLead && fallbackLead.id === activeId
        ? {
            card: fallbackLead,
            comments: [],
            transfers: [],
            statusHistory: [],
            attachments: [],
            partial: true,
          }
        : undefined,
    [fallbackLead, activeId],
  )

  const { data, isLoading, mutate } = useSWR<PartialDetail | null>(
    activeId ? ['manager-lead-detail', activeId] : null,
    () => getLeadCardDetailAction(activeId as string),
    { revalidateOnFocus: false, fallbackData: fallbackDetail },
  )
  const detail = data ?? null
  const card = detail?.card ?? null
  const hydrating = !detail || detail.partial === true
  const comments = detail?.comments ?? []
  const statusHistory = detail?.statusHistory ?? []

  function saveFreeComment() {
    if (!activeId || !freeComment.trim()) return
    startTransition(async () => {
      const res = await addLeadCommentAction({
        leadCardId: activeId,
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
    <SlideOver open={leadId !== null} onClose={onClose} title="Карточка лида">
      {!card ? (
        isLoading ? (
          <div className="flex flex-1 flex-col gap-4 px-4 py-4 sm:px-5">
            <SlideOverSectionSkeleton rows={3} />
            <SlideOverSectionSkeleton rows={2} />
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <SearchX className="size-6 text-muted-foreground" />
            <p className="text-sm font-medium">Лид не найден</p>
            <p className="text-xs text-muted-foreground">
              Карточка была удалена или у вас больше нет к ней доступа.
            </p>
          </div>
        )
      ) : (
        <div
          key={card.id}
          className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain"
        >
          <div className="flex flex-col gap-4 border-b border-border px-4 py-4 sm:px-5">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">
                {card.fullName || 'Без имени'}
              </h2>
              {card.vacancy ? (
                <p className="text-sm text-muted-foreground">{card.vacancy}</p>
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
                <dt className="text-xs text-muted-foreground">
                  Менеджер по кадрам
                </dt>
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

            {hydrating ? (
              <SlideOverSectionSkeleton rows={2} />
            ) : statusHistory.length > 0 ? (
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
                      <LeadHistoryEvent entry={h} />
                      {h.curatorName ? <span>— {h.curatorName}</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>

          {/* Файлы: фото/видео + кружки из диалога */}
          <div className="border-b border-border px-4 py-4 sm:px-5">
            {hydrating ? (
              <SlideOverSectionSkeleton rows={1} />
            ) : (
              <LeadAttachments
                leadCardId={card.id}
                conversationId={card.conversationId}
                attachments={detail?.attachments ?? []}
                onChanged={() => void mutate()}
              />
            )}
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
            {hydrating ? (
              <SlideOverSectionSkeleton rows={2} />
            ) : comments.length === 0 ? (
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
    </SlideOver>
  )
}
