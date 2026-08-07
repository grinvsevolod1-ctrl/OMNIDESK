'use client'

/**
 * Money-movement dialogs (top-up, statistics, expense entry) split out of
 * finance-dialogs.tsx. Fully props-driven like the rest of the finance modals.
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import {
  FINANCE_ENTRY_STATUSES,
  toUsd,
  type FinanceAdAccount,
  type FinanceCurrency,
  type FinanceEntry,
} from '@/lib/finance-types'
import {
  CURRENCY_SYMBOL,
  STATUS_META,
  formatUsd,
  todayISO,
  useRates,
} from '@/components/admin/finance/finance-utils'
import { CurrencySelect } from '@/components/admin/finance/finance-currency-select'

export function TopupDialog({
  account,
  pending,
  onClose,
  onSubmit,
}: {
  account: FinanceAdAccount | null
  pending: boolean
  onClose: () => void
  onSubmit: (id: string, fd: FormData) => void
}) {
  return (
    <Dialog open={account != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!account) return
            onSubmit(account.id, new FormData(e.currentTarget))
          }}
        >
          <DialogHeader>
            <DialogTitle>Пополнить баланс</DialogTitle>
            <DialogDescription>
              {account
                ? `${account.name} · ${CURRENCY_SYMBOL[account.currency]} ${account.currency}`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="top-amount">Сумма</Label>
                <Input
                  id="top-amount"
                  name="amount"
                  inputMode="decimal"
                  placeholder="10000"
                  autoFocus
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="top-date">Дата</Label>
                <Input
                  id="top-date"
                  name="topupDate"
                  type="date"
                  defaultValue={todayISO()}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="top-note">Комментарий</Label>
              <Input id="top-note" name="note" placeholder="Например: перевод с карты" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Пополнить'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function StatDialog({
  account,
  pending,
  onClose,
  onSubmit,
}: {
  account: FinanceAdAccount | null
  pending: boolean
  onClose: () => void
  onSubmit: (id: string, fd: FormData) => void
}) {
  return (
    <Dialog open={account != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!account) return
            onSubmit(account.id, new FormData(e.currentTarget))
          }}
        >
          <DialogHeader>
            <DialogTitle>Внести статистику</DialogTitle>
            <DialogDescription>
              {account
                ? `${account.name} — расход спишется с баланса, лиды пойдут в метрики.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="stat-start">Начало периода</Label>
                <Input
                  id="stat-start"
                  name="periodStart"
                  type="date"
                  defaultValue={todayISO()}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stat-end">Конец периода</Label>
                <Input
                  id="stat-end"
                  name="periodEnd"
                  type="date"
                  defaultValue={todayISO()}
                />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="stat-impr">Показы</Label>
                <Input id="stat-impr" name="impressions" inputMode="numeric" defaultValue="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stat-clicks">Клики</Label>
                <Input id="stat-clicks" name="clicks" inputMode="numeric" defaultValue="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="stat-leads">Лиды</Label>
                <Input id="stat-leads" name="leads" inputMode="numeric" defaultValue="0" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="stat-spend">
                Расход {account ? `(${account.currency})` : ''}
              </Label>
              <Input
                id="stat-spend"
                name="spend"
                inputMode="decimal"
                placeholder="0"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="stat-note">Комментарий</Label>
              <Input id="stat-note" name="note" placeholder="Например: неделя 1" />
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : 'Внести'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function EntryDialog({
  state,
  pending,
  onClose,
  onCreate,
  onUpdate,
}: {
  state:
    | { mode: 'create'; sectionId: string }
    | { mode: 'edit'; entry: FinanceEntry }
    | null
  pending: boolean
  onClose: () => void
  onCreate: (sectionId: string, fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
}) {
  const editing = state?.mode === 'edit' ? state.entry : null
  const rates = useRates()

  // Локальное состояние суммы/валюты для живого превью в USD.
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<FinanceCurrency>('USD')

  // Сброс значений при каждом открытии диалога под конкретную запись.
  // Синхронизация локального состояния формы с выбранной записью — валидный
  // сценарий, поэтому подавляем предупреждение о setState внутри эффекта.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!state) return
    if (state.mode === 'edit') {
      setAmount(String(state.entry.origAmount || state.entry.amount || ''))
      setCurrency(state.entry.origCurrency ?? 'USD')
    } else {
      setAmount('')
      setCurrency('USD')
    }
  }, [state])
  /* eslint-enable react-hooks/set-state-in-effect */

  const parsedAmount = Number.parseFloat(amount.replace(',', '.'))
  const usdPreview =
    Number.isFinite(parsedAmount) && parsedAmount > 0
      ? toUsd(parsedAmount, currency, rates)
      : null

  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else if (state?.mode === 'create') onCreate(state.sectionId, fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить расход' : 'Новый расход'}
            </DialogTitle>
            <DialogDescription>
              Сумму можно ввести в любой валюте — она сразу переводится в USD по
              текущему курсу и фиксируется.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="entry-title">Название</Label>
              <Input
                id="entry-title"
                name="title"
                defaultValue={editing?.title ?? ''}
                placeholder="Например: закупка контента"
                autoFocus
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="entry-vendor">Контрагент</Label>
              <Input
                id="entry-vendor"
                name="vendor"
                defaultValue={editing?.vendor ?? ''}
                placeholder="Кому платим"
              />
            </div>
            <div className="grid grid-cols-[1fr_auto] gap-3">
              <div className="space-y-2">
                <Label htmlFor="entry-amount">Сумма</Label>
                <Input
                  id="entry-amount"
                  name="amount"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="entry-currency">Валюта</Label>
                <CurrencySelect
                  name="currency"
                  value={currency}
                  onValueChange={(v) => setCurrency(v)}
                />
              </div>
            </div>
            {usdPreview != null && currency !== 'USD' && currency !== 'USDT' ? (
              <p className="-mt-1 text-sm text-muted-foreground">
                ≈ <span className="font-semibold text-foreground">{formatUsd(usdPreview)}</span>{' '}
                по курсу на сегодня
              </p>
            ) : null}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="entry-status">Статус</Label>
                <Select
                  name="status"
                  defaultValue={editing?.status ?? 'planned'}
                >
                  <SelectTrigger id="entry-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FINANCE_ENTRY_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {STATUS_META[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="entry-date">Дата</Label>
                <Input
                  id="entry-date"
                  name="entryDate"
                  type="date"
                  defaultValue={editing?.entryDate ?? todayISO()}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="entry-due">Оплатить до</Label>
                <Input
                  id="entry-due"
                  name="dueDate"
                  type="date"
                  defaultValue={editing?.dueDate ?? ''}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="entry-notes">Заметки / ответы</Label>
              <Textarea
                id="entry-notes"
                name="notes"
                defaultValue={editing?.notes ?? ''}
                rows={3}
                placeholder="Детали, ответы, ссылки…"
              />
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : editing ? (
                'Сохранить'
              ) : (
                'Добавить'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
