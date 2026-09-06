'use client'

/**
 * Диалог «Внести депозит» (бюджет) для админа/руководителя. Сумма вводится в
 * выбранной валюте; если она отличается от базовой валюты источника, вводится
 * курс, и депозит сохраняется приведённым к базовой валюте. Приходит pending —
 * байер подтверждает и отчитывается.
 */

import { useState, useTransition } from 'react'
import { Coins, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createDepositAction } from '@/app/actions/source-finance'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatMoney } from '@/lib/money'

const CURRENCIES = ['RUB', 'USD', 'EUR', 'USDT'] as const

export function DepositDialog({
  open,
  onOpenChange,
  source,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  source: { id: string; name: string; currency: string } | null
  onCreated?: () => void
}) {
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('RUB')
  const [fxRate, setFxRate] = useState('1')
  const [purpose, setPurpose] = useState('')
  const [pending, startTransition] = useTransition()

  const baseCurrency = source?.currency ?? 'RUB'
  const sameCurrency = currency === baseCurrency

  // Сброс формы при смене источника — паттерн «подстройка состояния при
  // рендере» (React docs) вместо useEffect: отслеживаем id открытого источника.
  const [formKey, setFormKey] = useState<string | null>(null)
  const activeKey = open && source ? source.id : null
  if (activeKey !== formKey) {
    setFormKey(activeKey)
    setCurrency(source?.currency ?? 'RUB')
    setFxRate('1')
    setAmount('')
    setPurpose('')
  }

  const amountNum = Number.parseFloat(amount)
  // Совпадающие валюты всегда идут по курсу 1 (поле курса скрыто).
  const rateNum = sameCurrency ? 1 : Number.parseFloat(fxRate)
  const converted =
    Number.isFinite(amountNum) && Number.isFinite(rateNum) && amountNum > 0
      ? Math.round(amountNum * rateNum * 100) / 100
      : 0

  function submit() {
    if (!source) return
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      toast.error('Введите сумму больше нуля.')
      return
    }
    if (!sameCurrency && (!Number.isFinite(rateNum) || rateNum <= 0)) {
      toast.error('Укажите корректный курс.')
      return
    }
    startTransition(async () => {
      try {
        await createDepositAction({
          sourceId: source.id,
          origAmount: amountNum,
          origCurrency: currency,
          fxRate: sameCurrency ? 1 : rateNum,
          purpose: purpose.trim() || undefined,
        })
        toast.success('Депозит внесён — ожидает подтверждения байером.')
        onOpenChange(false)
        onCreated?.()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось внести депозит.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Coins className="size-5 text-primary" />
            Внести депозит
          </DialogTitle>
          <DialogDescription>
            {source
              ? `Источник «${source.name}» · учёт в ${baseCurrency}`
              : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="dep-amount">Сумма</Label>
              <Input
                id="dep-amount"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0"
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dep-currency">Валюта</Label>
              <select
                id="dep-currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {!sameCurrency ? (
            <div className="space-y-1.5">
              <Label htmlFor="dep-rate">
                Курс: 1 {currency} = ? {baseCurrency}
              </Label>
              <Input
                id="dep-rate"
                inputMode="decimal"
                value={fxRate}
                onChange={(e) => setFxRate(e.target.value)}
                placeholder="напр. 92.5"
              />
              {converted > 0 ? (
                <p className="text-xs text-muted-foreground">
                  К зачислению: {formatMoney(converted, baseCurrency)}
                </p>
              ) : null}
            </div>
          ) : null}

          <div className="space-y-1.5">
            <Label htmlFor="dep-purpose">Назначение бюджета</Label>
            <Textarea
              id="dep-purpose"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Куда и на что направить бюджет…"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={pending} className="min-w-32">
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Coins className="size-4" />
            )}
            Внести
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
