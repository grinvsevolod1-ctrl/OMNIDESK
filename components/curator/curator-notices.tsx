'use client'

import { useTransition } from 'react'
import { Loader2, Sparkles, Undo2 } from 'lucide-react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  claimPoolLeadAction,
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
 * Обобщённая модалка уведомлений менеджера по кадрам (миграции 149, 150).
 * Показывает по одному непрочитанному уведомлению, самое свежее сверху.
 * Два вида:
 *   - lead_returned_from_archive — админ вернул лид из архива (с причиной);
 *   - lead_pool_available — новый лид в пуле команды: прямо из модалки можно
 *     «Взять в работу» (claim) или «Позже» (лид остаётся в пуле, в списке).
 * Поллинг раз в 30 секунд ловит новые события без перезагрузки.
 */
export function CuratorNotices({
  onLeadsChanged,
}: {
  /** Перечитать списки лидов после claim (лид уходит из пула в закреплённые). */
  onLeadsChanged?: () => void
}) {
  const { data, mutate } = useSWR('curator-notices', () => listMyNoticesAction(), {
    refreshInterval: 30_000,
    revalidateOnFocus: true,
  })
  const [pending, startTransition] = useTransition()

  const current = data && data.length > 0 ? data[0] : null
  const isPool = current?.kind === 'lead_pool_available'

  function dismiss() {
    if (!current) return
    startTransition(async () => {
      await markNoticeSeenAction(current.id)
      await mutate()
    })
  }

  function claim() {
    if (!current?.leadCardId) return
    startTransition(async () => {
      const res = await claimPoolLeadAction({ leadCardId: current.leadCardId! })
      // В любом исходе гасим это уведомление (лид взят — нами или другим).
      await markNoticeSeenAction(current.id)
      await mutate()
      if (res.ok) {
        toast.success(res.message)
        onLeadsChanged?.()
      } else {
        toast.error(res.message)
      }
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
            <span
              className={
                isPool
                  ? 'flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                  : 'flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary'
              }
            >
              {isPool ? (
                <Sparkles className="size-4" />
              ) : (
                <Undo2 className="size-4" />
              )}
            </span>
            {current?.title ?? 'Уведомление'}
          </DialogTitle>
        </DialogHeader>

        {current ? (
          isPool ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm">
                В пуле вашей команды появился лид
                {current.leadName ? (
                  <>
                    {' '}
                    <span className="font-medium">{current.leadName}</span>
                  </>
                ) : null}
                . Возьмите его в работу, если он ваш — кто первый, за тем лид и
                закрепляется.
              </p>
              {current.body ? (
                <div className="rounded-lg border border-border bg-muted/40 p-3">
                  <p className="whitespace-pre-wrap text-sm">{current.body}</p>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {current.leadName ? (
                <p className="text-sm">
                  Вам вернули лид{' '}
                  <span className="font-medium">{current.leadName}</span>. Он
                  снова в вашем активном рабочем месте.
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
                <p className="mt-1 whitespace-pre-wrap text-sm">
                  {current.body}
                </p>
              </div>
            </div>
          )
        ) : null}

        <DialogFooter>
          {isPool ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={dismiss}
              >
                Позже
              </Button>
              <Button
                size="sm"
                className="gap-1.5"
                disabled={pending}
                onClick={claim}
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Sparkles className="size-4" />
                )}
                Взять в работу
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={pending} onClick={dismiss}>
              Понятно
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
