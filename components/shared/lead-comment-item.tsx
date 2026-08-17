'use client'

import { useState, useTransition } from 'react'
import { Check, History, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { editLeadCommentAction } from '@/app/actions/lead-cards'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { leadStatusLabel, type LeadStatus } from '@/lib/lead-status'
import { APP_TIME_ZONE, mskDayKey } from '@/lib/time'

/** Минимальная форма комментария, одинаковая во всех панелях. */
export interface LeadCommentItemData {
  id: string
  authorId: string | null
  authorName: string | null
  body: string
  status: LeadStatus | null
  createdAt: string
  editedAt: string | null
  revisions: {
    id: string
    previousBody: string
    editedByName: string | null
    editedAt: string
  }[]
}

/**
 * Возможна ли правка комментария этим пользователем прямо сейчас:
 * только автор и только в МСК-день создания. Клиентская проверка лишь
 * прячет кнопку — сервер (editLeadCommentAction) проверяет заново.
 */
export function canEditComment(
  comment: { authorId: string | null; createdAt: string },
  viewerId: string | null | undefined,
): boolean {
  return (
    !!viewerId &&
    comment.authorId === viewerId &&
    mskDayKey(comment.createdAt) === mskDayKey(new Date())
  )
}

/**
 * Один комментарий в ленте: текст, бейдж статуса, «изменён» с историей
 * правок (прошлые тексты видны всем) и inline-правка для автора в день
 * создания. Используется в панелях куратора, менеджера и руководителя.
 */
export function LeadCommentItem({
  comment: c,
  leadCardId,
  canEdit,
  onSaved,
  fallbackAuthorLabel = '—',
}: {
  comment: LeadCommentItemData
  leadCardId: string
  canEdit: boolean
  onSaved: () => void
  fallbackAuthorLabel?: string
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(c.body)
  const [showHistory, setShowHistory] = useState(false)
  const [pending, startTransition] = useTransition()

  function save() {
    const body = draft.trim()
    if (!body || body === c.body) {
      setEditing(false)
      setDraft(c.body)
      return
    }
    startTransition(async () => {
      const res = await editLeadCommentAction({
        commentId: c.id,
        leadCardId,
        body,
      })
      if (res.ok) {
        toast.success(res.message)
        setEditing(false)
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <li className="rounded-lg border border-border bg-muted/30 px-3 py-2.5">
      <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {c.authorName ?? fallbackAuthorLabel}
        </span>
        {c.status ? (
          <Badge
            variant="outline"
            className="border-transparent bg-background text-[10px]"
          >
            {leadStatusLabel(c.status)}
          </Badge>
        ) : null}
        {c.editedAt ? (
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded text-[10px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
            onClick={() => setShowHistory((v) => !v)}
            title="Показать историю правок"
          >
            <History className="size-3" aria-hidden="true" />
            {'изменён'}
          </button>
        ) : null}
        <span className="ml-auto flex items-center gap-1.5">
          {formatCommentDateTime(c.createdAt)}
          {canEdit && !editing ? (
            <button
              type="button"
              className="rounded p-0.5 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setDraft(c.body)
                setEditing(true)
              }}
              aria-label="Изменить комментарий"
              title="Изменить (доступно до конца дня)"
            >
              <Pencil className="size-3" aria-hidden="true" />
            </button>
          ) : null}
        </span>
      </div>

      {editing ? (
        <div className="space-y-1.5">
          <Textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={3}
            className="text-sm"
            disabled={pending}
          />
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              className="h-7 gap-1 px-2 text-xs"
              onClick={save}
              disabled={pending || !draft.trim()}
            >
              <Check className="size-3" aria-hidden="true" />
              Сохранить
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 gap-1 px-2 text-xs"
              onClick={() => {
                setEditing(false)
                setDraft(c.body)
              }}
              disabled={pending}
            >
              <X className="size-3" aria-hidden="true" />
              Отмена
            </Button>
          </div>
        </div>
      ) : (
        <p className="whitespace-pre-wrap text-sm leading-relaxed">{c.body}</p>
      )}

      {showHistory && c.revisions.length > 0 ? (
        <div className="mt-2 space-y-1.5 border-t border-border pt-2">
          <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            История правок
          </p>
          {c.revisions.map((r) => (
            <div key={r.id} className="text-xs">
              <p className="whitespace-pre-wrap text-muted-foreground line-through decoration-muted-foreground/40">
                {r.previousBody}
              </p>
              <p className="mt-0.5 text-[10px] text-muted-foreground/70">
                {r.editedByName ? `${r.editedByName} — ` : ''}
                {formatCommentDateTime(r.editedAt)}
              </p>
            </div>
          ))}
        </div>
      ) : null}
    </li>
  )
}

function formatCommentDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}
