'use client'

/**
 * All finance-admin modal dialogs (source/ad-account/top-up/stat/expense entry
 * plus a generic confirm dialog) and the shared CurrencySelect, extracted from
 * the finance-admin monolith. Every dialog is fully props-driven (open state +
 * submit/close callbacks), so they carry no parent-scope coupling.
 */

import { useEffect, useState } from 'react'
import { Link as LinkIcon, Loader2, Trash2 } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  AD_PLATFORMS,
  AD_STATUSES,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  toUsd,
  type AdPlatform,
  type FinanceAdAccount,
  type FinanceCurrency,
  type FinanceEntry,
  type FinanceResource,
} from '@/lib/finance-types'
import {
  AD_STATUS_META,
  CURRENCY_SYMBOL,
  PLATFORM_META,
  STATUS_META,
  formatUsd,
  todayISO,
  useRates,
} from '@/components/admin/finance/finance-utils'

export function ResourceDialog({
  state,
  pending,
  onClose,
  onSubmit,
  onUpdate,
  onDelete,
}: {
  state:
    | { mode: 'create' }
    | { mode: 'edit'; resource: FinanceResource }
    | null
  pending: boolean
  onClose: () => void
  onSubmit: (fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
  onDelete: (resource: FinanceResource) => void
}) {
  const editing = state?.mode === 'edit' ? state.resource : null
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else onSubmit(fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить источник лидов' : 'Новый источник лидов'}
            </DialogTitle>
            <DialogDescription>
              Источник лидов — это площадка (например, site.com), внутри которой
              вы ведёте рекламные кабинеты и расходы. Все суммы учитываются в USD.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="res-name">Название</Label>
              <Input
                id="res-name"
                name="name"
                defaultValue={editing?.name ?? ''}
                placeholder="Например, site.com или «Лендинг Весна»"
                autoFocus
                required
              />
              <p className="text-xs text-muted-foreground">
                Короткое узнаваемое имя, по которому вы найдёте источник в списке.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="res-desc">Описание</Label>
              <Textarea
                id="res-desc"
                name="description"
                defaultValue={editing?.description ?? ''}
                placeholder="Необязательно: что это за источник, откуда идут лиды, кто ведёт"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Пара слов для контекста — поможет вспомнить детали позже.
              </p>
            </div>
            {editing ? (
              <div className="space-y-2">
                <Label htmlFor="res-archived">Статус</Label>
                <Select
                  name="archived"
                  defaultValue={editing.archived ? 'true' : 'false'}
                >
                  <SelectTrigger id="res-archived" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">Активен</SelectItem>
                    <SelectItem value="true">В архиве</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onDelete(editing)}
              >
                <Trash2 className="size-4" /> Удалить
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
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
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AdAccountDialog({
  state,
  pending,
  onClose,
  onCreate,
  onUpdate,
}: {
  state:
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; account: FinanceAdAccount }
    | null
  pending: boolean
  onClose: () => void
  onCreate: (resourceId: string, fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
}) {
  const editing = state?.mode === 'edit' ? state.account : null
  const [externalEnabled, setExternalEnabled] = useState(false)
  const [platform, setPlatform] = useState<AdPlatform>('yandex_direct')

  // This reusable dialog remains mounted; a changed entity must reset its draft.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state?.mode === 'edit') {
      setExternalEnabled(state.account.externalEnabled)
      setPlatform(state.account.platform)
    } else if (state?.mode === 'create') {
      setExternalEnabled(false)
      setPlatform('yandex_direct')
    }
  }, [state])
  /* eslint-enable react-hooks/set-state-in-effect */

  const canIntegrate = platform === 'yandex_direct'

  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else if (state?.mode === 'create') onCreate(state.resourceId, fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить кабинет' : 'Новый рекламный кабинет'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="acc-name">Название</Label>
              <Input
                id="acc-name"
                name="name"
                defaultValue={editing?.name ?? ''}
                placeholder="Основной кабинет"
                autoFocus
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="acc-platform">Площадка</Label>
                <Select
                  name="platform"
                  value={platform}
                  onValueChange={(v) => setPlatform(v as AdPlatform)}
                >
                  <SelectTrigger id="acc-platform" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AD_PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PLATFORM_META[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="acc-status">Статус</Label>
                <Select
                  name="status"
                  defaultValue={editing?.status ?? 'active'}
                >
                  <SelectTrigger id="acc-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AD_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {AD_STATUS_META[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="acc-ref">Логин / номер</Label>
                <Input
                  id="acc-ref"
                  name="accountRef"
                  defaultValue={editing?.accountRef ?? ''}
                  placeholder="ID кабинета"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="acc-currency">Валюта</Label>
                <CurrencySelect
                  name="currency"
                  defaultValue={editing?.currency ?? 'RUB'}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="acc-note">Заметка</Label>
              <Textarea
                id="acc-note"
                name="note"
                defaultValue={editing?.note ?? ''}
                rows={2}
              />
            </div>

            {/* Прямая интеграция с Яндекс.Директом */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <LinkIcon className="size-4 text-muted-foreground" />
                    <Label
                      htmlFor="acc-external"
                      className="cursor-pointer font-medium"
                    >
                      Интеграция с Яндекс.Директом
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {canIntegrate
                      ? 'Статистика (показы, клики, лиды, расход) подтягивается автоматически. Пополнения остаются ручными.'
                      : 'Доступно только для площадки «Яндекс Директ».'}
                  </p>
                </div>
                <Switch
                  id="acc-external"
                  name="externalEnabled"
                  checked={externalEnabled}
                  onCheckedChange={setExternalEnabled}
                  disabled={!canIntegrate}
                />
              </div>

              {externalEnabled && canIntegrate ? (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  <div className="space-y-2">
                    <Label htmlFor="acc-yandex-login">Логин клиента (необяз.)</Label>
                    <Input
                      id="acc-yandex-login"
                      name="yandexLogin"
                      defaultValue={editing?.yandexLogin ?? ''}
                      placeholder="agency-client-login"
                    />
                    <p className="text-xs text-muted-foreground">
                      Для агентских аккаунтов — логин управляемого клиента.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="acc-yandex-token">OAuth-токен</Label>
                    <Input
                      id="acc-yandex-token"
                      name="yandexToken"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        editing?.hasToken
                          ? '•••••••• (сохранён — оставьте пустым, чтобы не менять)'
                          : 'y0_AgAAAA...'
                      }
                      required={!editing?.hasToken}
                    />
                    <p className="text-xs text-muted-foreground">
                      Токен хранится в зашифрованном виде и не отображается.
                    </p>
                  </div>
                </div>
              ) : null}
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

function CurrencySelect({
  name,
  defaultValue,
  value,
  onValueChange,
}: {
  name: string
  defaultValue?: FinanceCurrency
  value?: FinanceCurrency
  onValueChange?: (v: FinanceCurrency) => void
}) {
  return (
    <Select
      name={name}
      defaultValue={defaultValue}
      value={value}
      onValueChange={
        onValueChange
          ? (v) => onValueChange(v as FinanceCurrency)
          : undefined
      }
    >
      <SelectTrigger className="w-[110px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {FINANCE_CURRENCIES.map((c) => (
          <SelectItem key={c} value={c}>
            {c} {CURRENCY_SYMBOL[c]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

export function ConfirmDialog({
  state,
  pending,
  onClose,
}: {
  state: {
    title: string
    description: string
    onConfirm: () => void
  } | null
  pending: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          <DialogDescription>{state?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Отмена</Button>} />
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => state?.onConfirm()}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : 'Удалить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
