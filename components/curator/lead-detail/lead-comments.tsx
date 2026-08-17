'use client'

import { LeadFreeCommentForm } from '@/components/curator/lead-panel-forms'
import { Badge } from '@/components/ui/badge'
import { leadStatusLabel } from '@/lib/lead-status'
import { formatDateTime } from './format'
import type { LeadCommentView } from './types'

/**
 * Лента комментариев лида + форма свободного комментария.
 * readOnly (руководитель «только просмотр») — лента без формы.
 */
export function LeadComments({
  leadCardId,
  comments,
  onCommentSaved,
  readOnly = false,
}: {
  leadCardId: string
  comments: LeadCommentView[]
  onCommentSaved: () => void
  readOnly?: boolean
}) {
  return (
    <>
      <p className="text-sm font-semibold">Комментарии</p>
      {readOnly ? null : (
        <LeadFreeCommentForm leadCardId={leadCardId} onSaved={onCommentSaved} />
      )}
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
                <span className="ml-auto">{formatDateTime(c.createdAt)}</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">
                {c.body}
              </p>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}
