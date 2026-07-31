'use client'

/**
 * Conversation hand-off dialog, extracted verbatim from inbox-view.tsx.
 *
 * Pure presentational + callbacks: the host owns all state (which conversation
 * is being transferred, the selected colleague, the note, the pending flag) and
 * the submit action. Keeping it here trims the large InboxView orchestrator and
 * lets the React Compiler memoize this small leaf independently.
 */

import { Loader2, UserPlus } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

export interface TransferTargetOption {
  id: string
  name: string
  onLunch: boolean
}

export function TransferDialog({
  open,
  onClose,
  targets,
  selectedId,
  onSelect,
  note,
  onNoteChange,
  pending,
  onSubmit,
}: {
  /** True while a conversation is queued for hand-off. */
  open: boolean
  /** Called to dismiss the dialog (cancel / backdrop / submit success). */
  onClose: () => void
  /** Colleagues this manager can hand the conversation off to. */
  targets: TransferTargetOption[]
  /** Currently selected colleague id ('' = none). */
  selectedId: string
  onSelect: (id: string) => void
  /** Optional note for the receiving colleague. */
  note: string
  onNoteChange: (note: string) => void
  /** True while the transfer server action is in flight. */
  pending: boolean
  onSubmit: () => void
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Передать диалог</DialogTitle>
          <DialogDescription>
            Диалог перейдёт выбранному менеджеру и исчезнет из ваших входящих.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 py-2">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">
              Кому передать
            </span>
            <div className="scrollbar-thin flex max-h-56 flex-col gap-1 overflow-y-auto">
              {targets.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => onSelect(t.id)}
                  className={cn(
                    'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                    selectedId === t.id
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border hover:bg-muted',
                  )}
                >
                  <span className="flex items-center gap-2">
                    <Avatar className="size-6">
                      <AvatarFallback className="text-[10px]">
                        {t.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    {t.name}
                  </span>
                  {t.onLunch ? (
                    <span className="text-xs text-muted-foreground">
                      на обеде
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-foreground">
              Заметка для коллеги (необязательно)
            </span>
            <Textarea
              value={note}
              onChange={(e) => onNoteChange(e.target.value)}
              placeholder="Например: клиент ждёт расчёт по доставке"
              maxLength={500}
              rows={3}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={onSubmit} disabled={pending || !selectedId}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <UserPlus className="size-4" />
            )}
            Передать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
