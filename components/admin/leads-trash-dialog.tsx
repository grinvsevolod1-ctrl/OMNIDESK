'use client'

import { useState, useTransition } from 'react'
import { ArchiveRestore, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  hardDeleteLeadAction,
  listTrashAction,
  restoreLeadAction,
} from '@/app/actions/lead-cards'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { DeletedLead } from '@/lib/data/lead-cards'
import { APP_TIME_ZONE } from '@/lib/time'

function fmt(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

/**
 * «Корзина» удалённых лидов: причина, кто удалил, восстановление.
 * Физическая очистка — автоматически через 30 дней (cron).
 */
export function LeadsTrashDialog({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, mutate } = useSWR(
    open ? 'leads-trash' : null,
    () => listTrashAction(),
    { revalidateOnFocus: false },
  )

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="h-9"
            aria-label="Корзина лидов"
          >
            <Trash2 className="size-4 shrink-0" />
            Корзина
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Корзина</DialogTitle>
          <DialogDescription>
            Удалённые лиды хранятся 30 дней, затем стираются автоматически.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Загрузка…
          </p>
        ) : !data || data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Корзина пуста
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.map((lead) => (
              <TrashItem
                key={lead.id}
                lead={lead}
                onChanged={() => {
                  void mutate()
                  onChanged()
                }}
              />
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  )
}

function TrashItem({
  lead,
  onChanged,
}: {
  lead: DeletedLead
  onChanged: () => void
}) {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [pending, startTransition] = useTransition()

  function restore() {
    startTransition(async () => {
      const res = await restoreLeadAction(lead.id)
      if (res.ok) {
        toast.success(res.message)
        onChanged()
      } else {
        toast.error(res.message)
      }
    })
  }

  function hardDelete() {
    startTransition(async () => {
      const res = await hardDeleteLeadAction({ leadCardId: lead.id })
      if (res.ok) {
        toast.success(res.message)
        onChanged()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <li className="flex flex-col gap-2 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {lead.fullName || 'Без имени'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {[lead.city, lead.phone].filter(Boolean).join(' · ')}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            Причина: {lead.deletedReason || '—'}
            {lead.deletedByName ? ` · ${lead.deletedByName}` : ''}
          </p>
        </div>
        <Badge
          variant="outline"
          className="shrink-0 border-transparent bg-muted text-muted-foreground"
        >
          {fmt(lead.deletedAt)}
        </Badge>
        <div className="flex shrink-0 items-center">
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Восстановить лид"
            title="Восстановить"
            disabled={pending}
            onClick={restore}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ArchiveRestore className="size-4" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Удалить навсегда"
            title="Удалить навсегда"
            className="text-muted-foreground hover:text-destructive"
            disabled={pending}
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {confirmDelete ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-2.5">
          <p className="text-xs text-destructive">
            Удалить лид «{lead.fullName || 'без имени'}» навсегда? Действие
            необратимо — вся история будет стёрта.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmDelete(false)}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={hardDelete}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              Удалить навсегда
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}
