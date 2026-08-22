'use client'

/**
 * Диалог переноса лида в архив — с ЛЮБОГО текущего статуса, но только через
 * обязательный выбор нерабочей причины («Игнор» / «Отказался» / «Кинул»)
 * и обязательный комментарий. Рабочие статусы здесь не показываются, и
 * напрямую (без причины и комментария) отправить лид в архив нельзя.
 *
 * Подтверждение атомарно: статус меняется на выбранный, комментарий
 * сохраняется, событие фиксируется в истории, лид уходит в архив
 * (archiveLeadWithReasonAction → archiveLeadWithStatus, одна транзакция).
 */
import { useState, useTransition } from 'react'
import { Archive, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { archiveLeadWithReasonAction } from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import { CharCounter } from '@/components/ui/char-counter'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  ARCHIVE_LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  STATUS_COMMENT_MIN_LEN,
  type LeadStatus,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'

export function ArchiveLeadDialog({
  leadCardId,
  leadName,
  open,
  onOpenChange,
  onArchived,
}: {
  /** null — диалог закрыт (состояние живёт у родителя). */
  leadCardId: string | null
  leadName?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onArchived: () => void
}) {
  const [status, setStatus] = useState<LeadStatus | null>(null)
  const [comment, setComment] = useState('')
  const [pending, startTransition] = useTransition()

  const commentOk = comment.trim().length >= STATUS_COMMENT_MIN_LEN
  const canConfirm = status !== null && commentOk && !pending

  function reset() {
    setStatus(null)
    setComment('')
  }

  function confirm() {
    if (!leadCardId || !status || !commentOk) return
    startTransition(async () => {
      const res = await archiveLeadWithReasonAction({
        leadCardId,
        status,
        comment,
      })
      if (res.ok) {
        toast.success(res.message)
        reset()
        onOpenChange(false)
        onArchived()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset()
        onOpenChange(o)
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Archive className="size-4 text-muted-foreground" />
            Перенос в архив
          </DialogTitle>
          <DialogDescription>
            {leadName ? `${leadName}: в` : 'В'}ыберите нерабочий финальный
            статус и обязательно напишите комментарий — без них перенос не
            подтверждается.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label className="text-xs">Причина (финальный статус)</Label>
          <div className="flex flex-wrap gap-1.5">
            {ARCHIVE_LEAD_STATUSES.map((s) => {
              const tone = LEAD_STATUS_TONE[s]
              const active = status === s
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  aria-pressed={active}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-sm font-medium transition-colors',
                    active
                      ? cn(
                          'border-transparent ring-1 ring-primary/40',
                          tone.bg,
                          tone.text,
                        )
                      : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground',
                  )}
                >
                  {LEAD_STATUS_LABELS[s]}
                </button>
              )
            })}
          </div>
        </div>

        {status !== null ? (
          <div className="flex flex-col gap-1.5">
            <Label className="text-xs">Комментарий (обязательно)</Label>
            <Textarea
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder={`Почему «${LEAD_STATUS_LABELS[status]}»? Минимум ${STATUS_COMMENT_MIN_LEN} символов…`}
              rows={3}
              className="min-h-20 text-sm"
              autoFocus
            />
            <CharCounter value={comment} min={STATUS_COMMENT_MIN_LEN} />
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            Отмена
          </Button>
          <Button size="sm" disabled={!canConfirm} onClick={confirm}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Archive className="size-3.5" />
            )}
            Подтвердить и в архив
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
