'use client'

/**
 * Диалог удаления лида руководителем. Удаление — мягкое: лид уходит в корзину
 * администратора (soft-delete), из группы руководителя пропадает. Тумблер
 * «Удалить также у менеджера» ДОПОЛНИТЕЛЬНО физически стирает диалог и всю
 * переписку из системы (у менеджера в инбоксе лид исчезает совсем), но сама
 * карточка при этом сохраняется в корзине админа
 * (lead_cards.conversation_id → NULL по ON DELETE SET NULL).
 */
import { useState, useTransition } from 'react'
import { Loader2, Trash2, TriangleAlert } from 'lucide-react'
import { toast } from 'sonner'
import { headDeleteLeadAction } from '@/app/actions/heads'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

const REASON_MIN_LEN = 3
const REASON_MAX_LEN = 300

export function HeadDeleteLeadDialog({
  leadCardId,
  leadName,
  open,
  onOpenChange,
  onDeleted,
}: {
  leadCardId: string | null
  leadName?: string | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onDeleted: () => void
}) {
  const [reason, setReason] = useState('')
  const [alsoManager, setAlsoManager] = useState(false)
  const [pending, startTransition] = useTransition()

  const reasonOk = reason.trim().length >= REASON_MIN_LEN
  const canConfirm = reasonOk && !pending

  function reset() {
    setReason('')
    setAlsoManager(false)
  }

  function confirm() {
    if (!leadCardId || !reasonOk) return
    startTransition(async () => {
      const res = await headDeleteLeadAction({
        leadCardId,
        reason,
        alsoDeleteForManager: alsoManager,
      })
      if (res.ok) {
        toast.success(res.message)
        reset()
        onOpenChange(false)
        onDeleted()
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
            <Trash2 className="size-4 text-destructive" />
            Удаление лида
          </DialogTitle>
          <DialogDescription>
            {leadName ? `«${leadName}» будет ` : 'Лид будет '}
            перемещён в корзину администратора. Из вашей группы он пропадёт.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-1.5">
          <Label htmlFor="head-delete-reason" className="text-xs">
            Причина удаления
          </Label>
          <Textarea
            id="head-delete-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, REASON_MAX_LEN))}
            placeholder="Коротко опишите, почему удаляете лид…"
            rows={3}
            className="resize-none"
          />
          <CharCounter value={reason} min={REASON_MIN_LEN} max={REASON_MAX_LEN} />
        </div>

        <label
          className={cn(
            'flex items-start gap-3 rounded-xl border p-3 transition-colors',
            alsoManager
              ? 'border-destructive/40 bg-destructive/5'
              : 'border-border bg-muted/30',
          )}
        >
          <Switch
            checked={alsoManager}
            onCheckedChange={setAlsoManager}
            className="mt-0.5 shrink-0"
            aria-label="Удалить также у менеджера"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-sm font-medium">Удалить также у менеджера</span>
            <span className="text-xs text-muted-foreground">
              Диалог и вся переписка будут стёрты из системы безвозвратно — у
              менеджера в инбоксе лид исчезнет полностью. Карточка всё равно
              останется в корзине администратора.
            </span>
          </span>
        </label>

        {alsoManager ? (
          <div className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Переписку восстановить будет нельзя. Убедитесь, что она больше не
              нужна.
            </span>
          </div>
        ) : null}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Отмена
          </Button>
          <Button variant="destructive" onClick={confirm} disabled={!canConfirm}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Trash2 className="size-3.5" />
            )}
            Удалить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
