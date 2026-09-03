'use client'

import { useState, useTransition } from 'react'
import { Archive, Loader2, Trash2, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  hardDeleteLeadAction,
  listArchivedLeadsAdminAction,
  returnArchivedLeadToCuratorAction,
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
import { Textarea } from '@/components/ui/textarea'
import type { LeadCard } from '@/lib/data/lead-cards'
import { APP_TIME_ZONE } from '@/lib/time'
import { cn } from '@/lib/utils'

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
 * Админский «Архив» лидов: кто в архиве, когда туда попал, с возможностью
 * вернуть лид его менеджеру по кадрам (с обязательной причиной — куратор
 * получит модальное уведомление) либо удалить лид навсегда.
 */
export function LeadsArchiveDialog({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const { data, isLoading, mutate } = useSWR(
    open ? 'leads-archive' : null,
    () => listArchivedLeadsAdminAction(),
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
            aria-label="Архив лидов"
          >
            <Archive className="size-4 shrink-0" />
            Архив
          </Button>
        }
      />
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Архив лидов</DialogTitle>
          <DialogDescription>
            Лиды с нерабочим статусом, ушедшие из активного рабочего места.
            Можно вернуть менеджеру по кадрам или удалить навсегда.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Загрузка…
          </p>
        ) : !data || data.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            Архив пуст
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {data.map((lead) => (
              <ArchivedLeadItem
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

function ArchivedLeadItem({
  lead,
  onChanged,
}: {
  lead: LeadCard
  onChanged: () => void
}) {
  const [mode, setMode] = useState<'idle' | 'return' | 'delete'>('idle')
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()

  function doReturn() {
    startTransition(async () => {
      const res = await returnArchivedLeadToCuratorAction({
        leadCardId: lead.id,
        reason,
      })
      if (res.ok) {
        toast.success(res.message)
        setMode('idle')
        setReason('')
        onChanged()
      } else {
        toast.error(res.message)
      }
    })
  }

  function doDelete() {
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
            {[lead.city, lead.phone].filter(Boolean).join(' · ') || '—'}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {lead.curatorName
              ? `Менеджер по кадрам: ${lead.curatorName}`
              : 'Без менеджера по кадрам'}
          </p>
        </div>
        {lead.archivedAt ? (
          <Badge
            variant="outline"
            className="shrink-0 border-transparent bg-muted text-muted-foreground"
          >
            {fmt(lead.archivedAt)}
          </Badge>
        ) : null}
        {mode === 'idle' ? (
          <div className="flex shrink-0 items-center">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Вернуть менеджеру по кадрам"
              title="Вернуть менеджеру по кадрам"
              disabled={pending || !lead.curatorId}
              onClick={() => setMode('return')}
            >
              <Undo2 className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Удалить навсегда"
              title="Удалить навсегда"
              className="text-muted-foreground hover:text-destructive"
              disabled={pending}
              onClick={() => setMode('delete')}
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ) : null}
      </div>

      {mode === 'return' ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-2.5">
          <p className="text-xs font-medium text-muted-foreground">
            Причина возврата — её увидит менеджер по кадрам
          </p>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Почему лид возвращается в работу…"
            rows={2}
            className="min-h-16 text-sm"
            autoFocus
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setMode('idle')
                setReason('')
              }}
            >
              Отмена
            </Button>
            <Button
              size="sm"
              disabled={pending || reason.trim().length < 3}
              onClick={doReturn}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Undo2 className="size-3.5" />
              )}
              Вернуть
            </Button>
          </div>
        </div>
      ) : null}

      {mode === 'delete' ? (
        <div
          className={cn(
            'flex flex-col gap-2 rounded-lg border p-2.5',
            'border-destructive/40 bg-destructive/10',
          )}
        >
          <p className="text-xs text-destructive">
            Удалить лид «{lead.fullName || 'без имени'}» навсегда? Действие
            необратимо — вся история будет стёрта.
          </p>
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setMode('idle')}
            >
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={doDelete}
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
