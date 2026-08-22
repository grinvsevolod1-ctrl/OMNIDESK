'use client'

/**
 * Формы карточки лида куратора, вынесенные из lead-detail-panel.
 *
 * Зачем: обе формы держат текст в СВОЁМ состоянии. Раньше каждый символ,
 * набранный в textarea, обновлял состояние всей 450-строчной панели и
 * перерисовывал историю статусов, передачи и вложения — на слабых машинах
 * это ощущалось как «глюки» при вводе. Теперь при вводе перерисовывается
 * только маленькая форма; memo защищает её и от перерисовок родителя.
 */

import { memo, useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  addLeadCommentAction,
  adminSetLeadStatusAction,
  updateLeadStatusAction,
} from '@/app/actions/lead-cards'
import { headSetLeadStatusAction } from '@/app/actions/heads'
import { Button } from '@/components/ui/button'
import { CharCounter } from '@/components/ui/char-counter'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  SELECTABLE_LEAD_STATUSES,
  STATUS_COMMENT_MIN_LEN,
  type LeadStatus,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'

/**
 * Кнопки статусов + комментарий + сохранение. Локальное состояние ввода.
 * variant='admin' сохраняет через adminSetLeadStatusAction — та же карточка
 * работает и у менеджера по кадрам, и у админа.
 */
export const LeadStatusForm = memo(function LeadStatusForm({
  leadCardId,
  currentStatus,
  onSaved,
  variant = 'curator',
}: {
  leadCardId: string
  currentStatus: LeadStatus | null
  onSaved: () => void
  variant?: 'curator' | 'admin' | 'head'
}) {
  const [pickedStatus, setPickedStatus] = useState<LeadStatus | null>(null)
  const [comment, setComment] = useState('')
  const [pending, startTransition] = useTransition()
  const status: LeadStatus | '' = pickedStatus ?? currentStatus ?? ''

  function save() {
    if (!status) {
      toast.error('Выберите статус')
      return
    }
    if (comment.trim().length < STATUS_COMMENT_MIN_LEN) {
      toast.error(`Комментарий — минимум ${STATUS_COMMENT_MIN_LEN} символов`)
      return
    }
    startTransition(async () => {
      const action =
        variant === 'admin'
          ? adminSetLeadStatusAction
          : variant === 'head'
            ? headSetLeadStatusAction
            : updateLeadStatusAction
      const res = await action({
        leadCardId,
        status,
        comment,
      })
      if (res.ok) {
        toast.success(res.message)
        setComment('')
        setPickedStatus(null)
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="space-y-3 border-b border-border px-4 py-4 sm:px-5">
      <p className="text-sm font-semibold">Статус на сегодня</p>
      <div className="flex flex-wrap gap-1.5">
        {SELECTABLE_LEAD_STATUSES.map((s) => {
          const tone = LEAD_STATUS_TONE[s]
          const active = status === s
          return (
            <button
              key={s}
              type="button"
              onClick={() => setPickedStatus(s)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors',
                active
                  ? cn(
                      'border-transparent ring-1 ring-primary/40',
                      tone.bg,
                      tone.text,
                    )
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              {LEAD_STATUS_LABELS[s]}
            </button>
          )
        })}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs">Комментарий к статусу</Label>
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Почему сейчас такой статус?"
          rows={3}
        />
        <CharCounter value={comment} min={STATUS_COMMENT_MIN_LEN} />
      </div>
      <Button className="w-full" disabled={pending || !status} onClick={save}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : null}
        Подтвердить статус
      </Button>
    </div>
  )
})

/** Форма свободного комментария. Локальное состояние ввода. */
export const LeadFreeCommentForm = memo(function LeadFreeCommentForm({
  leadCardId,
  onSaved,
}: {
  leadCardId: string
  onSaved: () => void
}) {
  const [freeComment, setFreeComment] = useState('')
  const [pending, startTransition] = useTransition()

  function save() {
    if (!freeComment.trim()) return
    startTransition(async () => {
      const res = await addLeadCommentAction({
        leadCardId,
        body: freeComment,
      })
      if (res.ok) {
        toast.success(res.message)
        setFreeComment('')
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
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
        onClick={save}
      >
        Добавить комментарий
      </Button>
    </div>
  )
})
