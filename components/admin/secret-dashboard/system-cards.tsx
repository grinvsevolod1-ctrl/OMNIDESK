'use client'

import { Loader2, ServerCrash, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { SecretSystem } from './types'

const usd = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

/* ------------------------- Fake-502 confirm ------------------------- */

export function Confirm502Dialog({
  open,
  onOpenChange,
  pending,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  pending: boolean
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ServerCrash className="size-5 text-destructive" />
            Показать экран «502 Bad Gateway»?
          </DialogTitle>
          <DialogDescription>
            Все администраторы и менеджеры вместо своих кабинетов увидят страницу
            502 Bad Gateway, как будто сервис недоступен. Эта панель продолжит
            работать — вы сможете выключить режим в любой момент.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Отмена
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
            className="gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <ServerCrash className="size-4" />
            )}
            Включить 502
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ------------------------------ System bits ------------------------------ */

/**
 * Compact AI-balance widget for the God-panel header. A small pill shows the
 * remaining AI Gateway budget (tinted by health); clicking it opens a popover
 * with the full breakdown and any low/empty warning. Replaces the old full-width
 * banner so the balance is always in reach without eating vertical space.
 */
export function AiBalanceChip({ system }: { system: SecretSystem }) {
  const { aiBalanceOk, aiBalance, aiTotalUsed, aiBalanceMessage } = system

  // Unavailable: no key / request failed. Neutral pill + reason in the popover.
  if (!aiBalanceOk || aiBalance == null) {
    return (
      <Popover>
        <PopoverTrigger
          render={
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-muted-foreground"
              title="Баланс ИИ недоступен"
            >
              <Wallet className="size-4" />
              <span className="hidden sm:inline">ИИ</span>
              <span>—</span>
            </Button>
          }
        />
        <PopoverContent align="end" className="w-72">
          <p className="text-sm font-medium">Баланс ИИ недоступен</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {aiBalanceMessage ??
              'Задайте AI_GATEWAY_API_KEY, чтобы видеть остаток средств'}
          </p>
        </PopoverContent>
      </Popover>
    )
  }

  const empty = aiBalance <= 0
  const low = aiBalance < 5
  const pillTone = empty
    ? 'border-destructive/50 text-destructive'
    : low
      ? 'border-warning/50 text-warning'
      : 'border-success/50 text-success'

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className={cn('gap-1.5 tabular-nums', pillTone)}
            title="Баланс ИИ — подробнее"
          >
            <Wallet className="size-4" />
            <span className="hidden sm:inline">ИИ</span>
            {usd(aiBalance)}
          </Button>
        }
      />
      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">
            Баланс ИИ (менеджер)
          </span>
          <span className={cn('text-lg font-semibold tabular-nums', pillTone)}>
            {usd(aiBalance)}
          </span>
        </div>
        {aiTotalUsed != null ? (
          <div className="flex items-center justify-between border-t border-border pt-2">
            <span className="text-xs font-medium text-muted-foreground">
              Потрачено всего
            </span>
            <span className="text-sm font-semibold tabular-nums">
              {usd(aiTotalUsed)}
            </span>
          </div>
        ) : null}
        {empty ? (
          <p className="text-xs font-medium text-destructive">
            Средства закончились — ИИ перестанет отвечать. Пополните баланс AI
            Gateway.
          </p>
        ) : low ? (
          <p className="text-xs font-medium text-warning">
            Низкий остаток — скоро потребуется пополнение.
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}
