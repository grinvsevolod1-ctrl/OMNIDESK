'use client'

import { useTransition } from 'react'
import { Undo2 } from 'lucide-react'
import useSWR from 'swr'
import {
  listMyNoticesAction,
  markNoticeSeenAction,
} from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/**
 * Модальные уведомления менеджера по кадрам. Сейчас единственный тип —
 * «лид возвращён из архива администратором»: показываем, какой лид вернулся
 * и почему (причина, которую вписал админ). Показываем по одному, самое
 * свежее сверху; закрытие помечает уведомление прочитанным. Поллинг раз в
 * 30 секунд ловит новые возвраты без перезагрузки страницы.
 */
export function CuratorReturnNotices() {
  const { data, mutate } = useSWR('curator-notices', () => listMyNoticesAction(), {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  })
  const [pending, startTransition] = useTransition()

  // Показываем самое свежее уведомление (список отсортирован по дате DESC).
  const current = data && data.length > 0 ? data[0] : null

  function dismiss() {
    if (!current) return
    startTransition(async () => {
      await markNoticeSeenAction(current.id)
      await mutate()
    })
  }

  return (
    <Dialog
      open={current !== null}
      onOpenChange={(o) => {
        if (!o) dismiss()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <Undo2 className="size-4" />
            </span>
            {current?.title ?? 'Уведомление'}
          </DialogTitle>
        </DialogHeader>

        {current ? (
          <div className="flex flex-col gap-3">
            {current.leadName ? (
              <p className="text-sm">
                Вам вернули лид{' '}
                <span className="font-medium">{current.leadName}</span>. Он снова
                в вашем активном рабочем месте.
              </p>
            ) : (
              <p className="text-sm">
                Вам вернули лид — он снова в вашем активном рабочем месте.
              </p>
            )}
            <div className="rounded-lg border border-border bg-muted/40 p-3">
              <p className="text-xs font-medium text-muted-foreground">
                Причина возврата
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">{current.body}</p>
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button size="sm" disabled={pending} onClick={dismiss}>
            Понятно
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
