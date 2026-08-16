'use client'

/**
 * Секции «Каталог» и «Диалог покупки» вкладки «API TG» (Get My TG).
 * Вынесено из secret-gmt-tab.tsx. Часть god-панели — инварианты AGENTS.md §4.
 */

import { useMemo, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  ArrowDownUp,
  Boxes,
  KeyRound,
  Loader2,
  RefreshCw,
  Search,
  ShoppingCart,
  TriangleAlert,
  Zap,
} from 'lucide-react'
import {
  secretGmtBulkBuyAction,
  secretGmtBuyAction,
  secretGmtCountriesAction,
  secretGmtCountryDetailsAction,
  type GmtCountry,
  type GmtMoney,
  type GmtPurchase,
} from '@/app/actions/admin-secret'
import { Badge } from '@/components/ui/badge'
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
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import { TAG_META, fmtMoney, rememberBulkId } from './shared'

export function CatalogSection({
  balance,
  onPurchased,
  onBulkCreated,
}: {
  balance: GmtMoney | null
  onPurchased: (purchase: GmtPurchase) => void
  onBulkCreated: () => void
}) {
  const [countryFilter, setCountryFilter] = useState('')
  const [sortAsc, setSortAsc] = useState(true)
  const [onlyAvailable, setOnlyAvailable] = useState(true)
  const [buyTarget, setBuyTarget] = useState<GmtCountry | null>(null)

  const {
    data: countries,
    isLoading,
    mutate,
  } = useSWR(
    'gmt-countries',
    async () => {
      const res = await secretGmtCountriesAction('price_asc')
      if (!res.ok) throw new Error(res.message)
      return res.data ?? []
    },
    { revalidateOnFocus: false },
  )

  const visible = useMemo(() => {
    const list = countries ?? []
    const q = countryFilter.trim().toLowerCase()
    const filtered = list.filter((c) => {
      if (onlyAvailable && !c.available) return false
      if (!q) return true
      return (
        c.display_name.ru.toLowerCase().includes(q) ||
        c.display_name.en.toLowerCase().includes(q) ||
        c.country_code.toLowerCase().includes(q)
      )
    })
    const sorted = [...filtered].sort(
      (a, b) => Number(a.price.amount) - Number(b.price.amount),
    )
    return sortAsc ? sorted : sorted.reverse()
  }, [countries, countryFilter, sortAsc, onlyAvailable])

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Каталог</h3>
          <p className="text-xs text-muted-foreground">
            Цены с учётом персональной скидки · 1 шт или опт архивом
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search
              className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              placeholder="Страна или код (US, KZ)…"
              className="h-8 w-48 pl-8"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 bg-transparent"
            onClick={() => setSortAsc((v) => !v)}
          >
            <ArrowDownUp className="size-3.5" />
            {sortAsc ? 'Дешевле' : 'Дороже'}
          </Button>
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={onlyAvailable}
              onChange={(e) => setOnlyAvailable(e.target.checked)}
              className="size-3.5 accent-primary"
            />
            В наличии
          </label>
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={() => void mutate()}
            aria-label="Обновить каталог"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-16 rounded-md" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Search}
            title="Ничего не найдено"
            description="Попробуйте другой запрос или снимите фильтр наличия."
          />
        </div>
      ) : (
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((c) => (
            <div
              key={c.country_code}
              className={cn(
                'flex items-center justify-between gap-2 rounded-md border border-border p-3 transition-colors',
                c.available ? 'hover:border-primary/40' : 'opacity-50',
              )}
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="text-lg leading-none" aria-hidden>
                  {c.emoji}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm font-medium">
                      {c.display_name.ru}
                    </p>
                    <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                      {c.country_code}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <p className="text-xs font-semibold tabular-nums text-primary">
                      {fmtMoney(c.price)}
                    </p>
                    {typeof c.available_count === 'number' ? (
                      <span className="text-[10px] text-muted-foreground">
                        {c.available_count} шт
                      </span>
                    ) : null}
                    {c.tags.map((t) =>
                      TAG_META[t] ? (
                        <Badge
                          key={t}
                          variant="outline"
                          className={cn('px-1 py-0 text-[9px]', TAG_META[t].cls)}
                        >
                          {TAG_META[t].label}
                        </Badge>
                      ) : null,
                    )}
                  </div>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                className="h-7 shrink-0 gap-1 bg-transparent px-2 text-xs"
                disabled={!c.available}
                onClick={() => setBuyTarget(c)}
              >
                <ShoppingCart className="size-3" />
                Купить
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* key сбрасывает режим/количество при смене страны — без useEffect */}
      {buyTarget ? (
        <CheckoutDialog
          key={buyTarget.country_code}
          country={buyTarget}
          balance={balance}
          onClose={() => setBuyTarget(null)}
          onPurchased={onPurchased}
          onBulkCreated={onBulkCreated}
        />
      ) : null}
    </Card>
  )
}

/* --------------------------- Диалог покупки ----------------------------- */

function CheckoutDialog({
  country,
  balance,
  onClose,
  onPurchased,
  onBulkCreated,
}: {
  country: GmtCountry | null
  balance: GmtMoney | null
  onClose: () => void
  onPurchased: (purchase: GmtPurchase) => void
  onBulkCreated: () => void
}) {
  const [mode, setMode] = useState<'single' | 'bulk'>('single')
  const [qty, setQty] = useState(5)
  const [pending, startTransition] = useTransition()

  // Разбивка цены со скидкой — подгружается при открытии чекаута.
  const { data: details } = useSWR(
    country ? ['gmt-country-details', country.country_code] : null,
    async () => {
      const res = await secretGmtCountryDetailsAction(country!.country_code)
      return res.ok ? (res.data ?? null) : null
    },
    { revalidateOnFocus: false },
  )

  if (!country) return null

  const unit = Number(details?.price.amount ?? country.price.amount)
  const total = mode === 'single' ? unit : unit * qty
  const balanceNum = balance ? Number(balance.amount) : null
  const insufficient = balanceNum !== null && total > balanceNum

  function confirmBuy() {
    const target = country
    if (!target) return
    startTransition(async () => {
      if (mode === 'single') {
        const res = await secretGmtBuyAction(target.country_code)
        if (res.ok && res.data) {
          toast.success(
            `Куплен номер ${res.data.phone_number ?? '—'} — импортируем в god-аккаунты`,
          )
          onClose()
          onPurchased(res.data)
        } else {
          toast.error(res.message)
        }
      } else {
        const res = await secretGmtBulkBuyAction(target.country_code, qty)
        if (res.ok && res.data) {
          rememberBulkId(res.data.bulk_purchase_id)
          toast.success(
            `Оптовая закупка №${res.data.bulk_purchase_id} создана — архив готовится`,
          )
          onClose()
          onBulkCreated()
        } else {
          toast.error(res.message)
        }
      }
    })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <span className="text-xl" aria-hidden>
              {country.emoji}
            </span>
            {country.display_name.ru}
          </DialogTitle>
          <DialogDescription>
            Баланс списывается сразу. Одиночная покупка: код запрашивается
            после. Опт: архив с сессиями готовится асинхронно.
          </DialogDescription>
        </DialogHeader>

        {/* Режим покупки */}
        <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
          {(
            [
              { id: 'single', label: '1 аккаунт', icon: KeyRound },
              { id: 'bulk', label: 'Опт (архив)', icon: Boxes },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
                mode === m.id
                  ? 'bg-background font-medium shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <m.icon className="size-3.5" aria-hidden />
              {m.label}
            </button>
          ))}
        </div>

        {mode === 'bulk' ? (
          <div className="flex flex-wrap items-center gap-3">
            <label htmlFor="gmt-qty" className="text-sm text-muted-foreground">
              Количество
            </label>
            <Input
              id="gmt-qty"
              type="number"
              min={1}
              max={100}
              value={qty}
              onChange={(e) =>
                setQty(
                  Math.max(
                    1,
                    Math.min(100, Math.round(Number(e.target.value) || 1)),
                  ),
                )
              }
              className="h-8 w-24 tabular-nums"
            />
            <div className="flex gap-1">
              {[5, 10, 25, 50].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setQty(n)}
                  className={cn(
                    'rounded border px-2 py-0.5 text-xs transition-colors',
                    qty === n
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {n}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* Смета */}
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/20 p-3 text-sm">
          {details && details.discount.percent > 0 ? (
            <div className="flex justify-between text-muted-foreground">
              <span>Базовая цена</span>
              <span className="tabular-nums line-through">
                {details.discount.base_price} {details.price.currency_code}
              </span>
            </div>
          ) : null}
          <div className="flex justify-between">
            <span className="text-muted-foreground">
              Цена за аккаунт
              {details && details.discount.percent > 0 ? (
                <span className="ml-1 text-success">
                  −{details.discount.percent}%
                </span>
              ) : null}
            </span>
            <span className="font-medium tabular-nums">
              {fmtMoney(details?.price ?? country.price)}
            </span>
          </div>
          {mode === 'bulk' ? (
            <div className="flex justify-between">
              <span className="text-muted-foreground">Количество</span>
              <span className="tabular-nums">× {qty}</span>
            </div>
          ) : null}
          <div className="mt-1 flex justify-between border-t border-border pt-2 font-semibold">
            <span>Итого</span>
            <span className="tabular-nums text-primary">
              {total.toFixed(2)} {country.price.currency_code}
            </span>
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>Баланс после покупки</span>
            <span className={cn('tabular-nums', insufficient && 'text-destructive')}>
              {balanceNum === null
                ? '—'
                : `${(balanceNum - total).toFixed(2)} ${country.price.currency_code}`}
            </span>
          </div>
        </div>

        {insufficient ? (
          <p className="flex items-center gap-1.5 text-xs text-destructive">
            <TriangleAlert className="size-3.5" aria-hidden />
            Недостаточно средств — пополните баланс у бота сервиса.
          </p>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={confirmBuy} disabled={pending || insufficient}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Zap className="size-3.5" />
            )}
            {mode === 'single'
              ? 'Купить'
              : `Купить ${qty} шт`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
