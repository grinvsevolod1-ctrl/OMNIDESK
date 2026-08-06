'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  addLeadCommentAction,
  getLeadCardDetailAction,
  updateLeadStatusAction,
} from '@/app/actions/lead-cards'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { LeadCard, LeadCardComment } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  leadStatusLabel,
  needsDailyStatusUpdate,
  STATUS_COMMENT_MIN_LEN,
  type LeadStatus,
} from '@/lib/lead-status'
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

export function LeadDetailPanel({
  leadId,
  onClose,
  onUpdated,
}: {
  leadId: string
  onClose: () => void
  onUpdated: () => void
}) {
  const [card, setCard] = useState<LeadCard | null>(null)
  const [comments, setComments] = useState<LeadCardComment[]>([])
  const [loading, setLoading] = useState(true)
  const [status, setStatus] = useState<LeadStatus | ''>('')
  const [comment, setComment] = useState('')
  const [freeComment, setFreeComment] = useState('')
  const [pending, startTransition] = useTransition()

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    void getLeadCardDetailAction(leadId).then((res) => {
      if (cancelled || !res) return
      setCard(res.card)
      setComments(res.comments)
      setStatus(res.card.status ?? '')
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [leadId])

  function saveStatus() {
    if (!status) {
      toast.error('Выберите статус')
      return
    }
    if (comment.trim().length < STATUS_COMMENT_MIN_LEN) {
      toast.error(`Комментарий — минимум ${STATUS_COMMENT_MIN_LEN} символов`)
      return
    }
    startTransition(async () => {
      const res = await updateLeadStatusAction({
        leadCardId: leadId,
        status,
        comment,
      })
      if (res.ok) {
        toast.success(res.message)
        setComment('')
        onUpdated()
        const fresh = await getLeadCardDetailAction(leadId)
        if (fresh) {
          setCard(fresh.card)
          setComments(fresh.comments)
        }
      } else {
        toast.error(res.message)
      }
    })
  }

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
        const fresh = await getLeadCardDetailAction(leadId)
        if (fresh) setComments(fresh.comments)
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
          <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Закрыть">
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
            <div className="space-y-4 border-b border-border px-4 py-4 sm:px-5">
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
                    needsUpdate={needsDailyStatusUpdate(card.statusConfirmedDate)}
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
                {card.address ? (
                  <div className="sm:col-span-2">
                    <dt className="text-xs text-muted-foreground">Адрес</dt>
                    <dd className="font-medium">{card.address}</dd>
                  </div>
                ) : null}
                <div>
                  <dt className="text-xs text-muted-foreground">Менеджер</dt>
                  <dd className="font-medium">{card.managerName ?? '—'}</dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Передан</dt>
                  <dd className="font-medium">
                    {card.transferredAt
                      ? formatDateTime(card.transferredAt)
                      : '—'}
                  </dd>
                </div>
              </dl>
            </div>

            {/* Status form */}
            <div className="space-y-3 border-b border-border px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold">Статус на сегодня</p>
              <div className="flex flex-wrap gap-1.5">
                {LEAD_STATUSES.map((s) => {
                  const tone = LEAD_STATUS_TONE[s]
                  const active = status === s
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setStatus(s)}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                        active
                          ? cn('border-transparent ring-1 ring-primary/40', tone.bg, tone.text)
                          : 'border-border text-muted-foreground hover:bg-muted',
                      )}
                    >
                      {LEAD_STATUS_LABELS[s]}
                    </button>
                  )
                })}
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">
                  Комментарий к статусу{' '}
                  <span className="text-muted-foreground">
                    (мин. {STATUS_COMMENT_MIN_LEN} символов)
                  </span>
                </Label>
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Почему сейчас такой статус?"
                  rows={3}
                />
                <p className="text-[11px] text-muted-foreground">
                  {comment.trim().length}/{STATUS_COMMENT_MIN_LEN}
                </p>
              </div>
              <Button
                className="w-full"
                disabled={pending || !status}
                onClick={saveStatus}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Подтвердить статус
              </Button>
            </div>

            {/* Comments */}
            <div className="space-y-3 px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold">Комментарии</p>
              <div className="flex flex-col gap-2">
                <Textarea
                  value={freeComment}
                  onChange={(e) => setFreeComment(e.target.value)}
                  placeholder="Дополнительный комментарий…"
                  rows={2}
                />
                <Button
                  variant="outline"
                  size="sm"
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
                          {c.authorName ?? 'Куратор'}
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
