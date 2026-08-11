'use client'

import { useEffect, useTransition } from 'react'
import { Loader2, X } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  getLeadCardDetailAction,
  returnLeadToFunnelAction,
  setLeadArchivedAction,
} from '@/app/actions/lead-cards'
import {
  LeadFreeCommentForm,
  LeadStatusForm,
} from '@/components/curator/lead-panel-forms'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { LeadAttachments } from '@/components/shared/lead-attachments'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  isFinalLeadStatus,
  leadStatusLabel,
  leadNeedsDailyStatus,
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
  const [pending, startTransition] = useTransition()

  const { data: detail, isLoading: loading, mutate } = useSWR(
    ['lead-detail', leadId],
    () => getLeadCardDetailAction(leadId),
    // keepPreviousData: при ревалидации после сохранения статуса панель не
    // мигает спиннером — старые данные видны, пока грузятся новые.
    { revalidateOnFocus: false, keepPreviousData: true },
  )
  const card = detail?.card ?? null
  const comments = detail?.comments ?? []
  const transfers = detail?.transfers ?? []
  const statusHistory = detail?.statusHistory ?? []

  // Esc закрывает карточку (кастомный оверлей — без встроенной обработки).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  /** После сохранения статуса: обновить панель и список снаружи. */
  function onStatusSaved() {
    onUpdated()
    void mutate()
  }

  /** После свободного комментария достаточно обновить панель. */
  function onCommentSaved() {
    void mutate()
  }

  function toggleArchive(archived: boolean) {
    startTransition(async () => {
      const res = await setLeadArchivedAction({ leadCardId: leadId, archived })
      if (res.ok) {
        toast.success(res.message)
        onUpdated()
        await mutate()
      } else {
        toast.error(res.message)
      }
    })
  }

  function returnToFunnel() {
    startTransition(async () => {
      const res = await returnLeadToFunnelAction({ leadCardId: leadId })
      if (res.ok) {
        toast.success(res.message)
        onUpdated()
        onClose()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button
        type="button"
        className="absolute inset-0 bg-black/30 animate-in fade-in duration-200 supports-backdrop-filter:backdrop-blur-[2px]"
        aria-label="Закрыть"
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          'relative z-10 flex h-full w-full flex-col bg-popover shadow-2xl ring-1 ring-foreground/10',
          // Полный проезд от края + ease-out — то же плавное появление,
          // что и у docked-карточки в Inbox менеджера.
          'animate-in duration-300 ease-out max-sm:slide-in-from-bottom sm:slide-in-from-right',
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
                    needsUpdate={leadNeedsDailyStatus(card)}
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

              {statusHistory.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    История статусов
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

              {transfers.length > 0 ? (
                <div>
                  <p className="mb-1.5 text-xs font-medium text-muted-foreground">
                    История передач
                  </p>
                  <ul className="flex flex-col gap-1">
                    {transfers.map((t) => (
                      <li
                        key={t.id}
                        className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                      >
                        <span>{formatDateTime(t.createdAt)}</span>
                        <span>
                          {t.fromCuratorName
                            ? `${t.fromCuratorName} → ${t.toCuratorName ?? '—'}`
                            : `→ ${t.toCuratorName ?? '—'}`}
                        </span>
                        <span className="rounded bg-muted px-1 py-0.5 text-[10px]">
                          {t.initiatedByRole === 'admin' ? 'админ' : 'менеджер'}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>

            {/* Файлы: фото/видео. Кружки из диалога выбирает МЕНЕДЖЕР в своём
                инбоксе — менеджер по кадрам диалог не ведёт и содержимое
                переписки не просматривает, поэтому conversationId не передаём. */}
            <div className="border-b border-border px-4 py-4 sm:px-5">
              <LeadAttachments
                leadCardId={leadId}
                conversationId={null}
                attachments={detail?.attachments ?? []}
                onChanged={() => void mutate()}
              />
            </div>

            {/* Lifecycle: final leads can be archived or sent back to the AI */}
            {isFinalLeadStatus(card.status) ? (
              <div className="space-y-2 border-b border-border px-4 py-4 sm:px-5">
                <p className="text-sm font-semibold">Жизненный цикл</p>
                <p className="text-xs text-muted-foreground">
                  Финальный статус: ежедневное подтверждение больше не требуется.
                </p>
                <div className="flex flex-wrap gap-2">
                  {card.archivedAt ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => toggleArchive(false)}
                    >
                      Вернуть из архива
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => toggleArchive(true)}
                    >
                      В архив
                    </Button>
                  )}
                  {card.conversationId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={returnToFunnel}
                    >
                      Вернуть в воронку ИИ
                    </Button>
                  ) : null}
                </div>
              </div>
            ) : null}

            {/* Форма статуса — отдельный memo-компонент с собственным
                состоянием: ввод комментария не перерисовывает панель. */}
            <LeadStatusForm
              leadCardId={leadId}
              currentStatus={card.status}
              onSaved={onStatusSaved}
            />

            {/* Comments */}
            <div className="space-y-3 px-4 py-4 sm:px-5">
              <p className="text-sm font-semibold">Комментарии</p>
              <LeadFreeCommentForm leadCardId={leadId} onSaved={onCommentSaved} />
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
                          {c.authorName ?? 'Менеджер по кадрам'}
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
