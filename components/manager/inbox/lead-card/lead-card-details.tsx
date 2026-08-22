'use client'

import {
  canEditComment,
  LeadCommentItem,
} from '@/components/shared/lead-comment-item'
import { LeadHistoryEvent } from '@/components/shared/lead-history-event'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { APP_TIME_ZONE } from '@/lib/time'
import type { LeadCardState } from './use-lead-card'

/**
 * Секции сохранённой карточки: статус у менеджера по кадрам с историей
 * и комментарии (двусторонние — менеджер пишет, видит ответы).
 */
export function LeadCardDetails({ state }: { state: LeadCardState }) {
  const { detail, pending, freeComment, setFreeComment, submitComment } = state
  return (
    <>
      {/* Статус менеджера по кадрам — менеджер видит текущий статус и историю */}
      {detail?.card?.status || detail?.statusHistory?.length ? (
        <div className="flex flex-col gap-2 border-t border-border pt-3.5">
          <p className="text-sm font-semibold">Статус у менеджера по кадрам</p>
          {detail?.card ? (
            <LeadStatusBadge
              status={detail.card.status}
              previousStatus={detail.card.previousStatus}
            />
          ) : null}
          {detail?.statusHistory?.length ? (
            <ul className="flex flex-col gap-1">
              {detail.statusHistory.slice(0, 5).map((h) => (
                <li
                  key={h.id}
                  className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <span>{formatPanelDateTime(h.createdAt)}</span>
                  <LeadHistoryEvent entry={h} />
                  {h.curatorName ? <span>— {h.curatorName}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {/* Комментарии: менеджер пишет свои и видит комментарии менеджера по кадрам */}
      <div className="flex flex-col gap-2 border-t border-border pt-3.5">
        <p className="text-sm font-semibold">Комментарии</p>
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
          onClick={submitComment}
        >
          Добавить комментарий
        </Button>
        {(detail?.comments ?? []).length === 0 ? (
          <p className="text-xs text-muted-foreground">Пока пусто</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(detail?.comments ?? []).map((c) => (
              <LeadCommentItem
                key={c.id}
                comment={c}
                leadCardId={detail?.card?.id ?? ''}
                onSaved={() => void state.mutateDetail()}
                canEdit={canEditComment(c, detail?.viewerId)}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  )
}

export function formatPanelDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}
