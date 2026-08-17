'use client'

import { LeadFreeCommentForm } from '@/components/curator/lead-panel-forms'
import {
  canEditComment,
  LeadCommentItem,
} from '@/components/shared/lead-comment-item'
import type { LeadCommentView } from './types'

/**
 * Лента комментариев лида + форма свободного комментария.
 * readOnly (руководитель «только просмотр») — лента без формы.
 * Свой комментарий можно править, но только в день его создания (по МСК);
 * прошлый текст сохраняется в истории и виден всем по бейджу «изменён».
 */
export function LeadComments({
  leadCardId,
  comments,
  onCommentSaved,
  readOnly = false,
  viewerId = null,
}: {
  leadCardId: string
  comments: LeadCommentView[]
  onCommentSaved: () => void
  readOnly?: boolean
  /** Кто смотрит: «Изменить» доступно только автору. */
  viewerId?: string | null
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
            <LeadCommentItem
              key={c.id}
              comment={c}
              leadCardId={leadCardId}
              onSaved={onCommentSaved}
              canEdit={!readOnly && canEditComment(c, viewerId)}
              fallbackAuthorLabel="Менеджер по кадрам"
            />
          ))}
        </ul>
      )}
    </>
  )
}
