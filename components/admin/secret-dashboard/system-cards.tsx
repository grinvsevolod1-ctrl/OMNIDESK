'use client'

import { Loader2, ServerCrash, Wallet } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import type { SecretSystem } from './types'

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
 * Prominent, always-visible balance panel showing the AI manager's remaining
 * AI Gateway budget. Shown at the top of every section so it can't be missed.
 */
export function AiBalanceBanner({ system }: { system: SecretSystem }) {
  const { aiBalanceOk, aiBalance, aiTotalUsed, aiBalanceMessage } = system
  const usd = (n: number) =>
    `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Unavailable: no key / request failed. Neutral card with the reason.
  if (!aiBalanceOk || aiBalance == null) {
    return (
      <Card className="flex items-center gap-3 border-dashed p-4">
        <div className="flex size-10 items-center justify-center rounded-lg border border-border bg-muted/40">
          <Wallet className="size-5 text-muted-foreground" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">Баланс ИИ недоступен</p>
          <p className="truncate text-xs text-muted-foreground">
            {aiBalanceMessage ??
              'Задайте AI_GATEWAY_API_KEY, чтобы видеть остаток средств'}
          </p>
        </div>
      </Card>
    )
  }

  const empty = aiBalance <= 0
  const low = aiBalance < 5
  const tone = empty
    ? 'border-destructive/40 bg-destructive/5'
    : low
      ? 'border-warning/40 bg-warning/5'
      : 'border-success/40 bg-success/5'
  const iconTone = empty
    ? 'text-destructive'
    : low
      ? 'text-warning'
      : 'text-success'

  return (
    <Card className={cn('flex flex-wrap items-center gap-4 p-4', tone)}>
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex size-11 items-center justify-center rounded-xl border border-border bg-background/60',
            iconTone,
          )}
        >
          <Wallet className="size-5" />
        </div>
        <div>
          <p className="text-xs font-medium text-muted-foreground">
            Баланс ИИ (менеджер)
          </p>
          <p className={cn('text-2xl font-semibold tabular-nums', iconTone)}>
            {usd(aiBalance)}
          </p>
        </div>
      </div>

      {aiTotalUsed != null && (
        <div className="ml-auto text-right">
          <p className="text-xs font-medium text-muted-foreground">
            Потрачено всего
          </p>
          <p className="text-lg font-semibold tabular-nums">{usd(aiTotalUsed)}</p>
        </div>
      )}

      {empty ? (
        <p className="w-full text-xs font-medium text-destructive">
          Средства закончились — ИИ перестанет отвечать. Пополните баланс AI
          Gateway.
        </p>
      ) : low ? (
        <p className="w-full text-xs font-medium text-warning">
          Низкий остаток — скоро потребуется пополнение.
        </p>
      ) : null}
    </Card>
  )
}
