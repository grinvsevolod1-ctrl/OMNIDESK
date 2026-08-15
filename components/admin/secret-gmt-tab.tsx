'use client'

/**
 * God-панель, вкладка «API TG» — покупка Telegram-аккаунтов через Get My TG
 * (docs.getmytg.com). Часть скрытой панели: подчиняется инвариантам AGENTS.md
 * §4 (обычная админка и Admin AI о вкладке не знают).
 *
 * Данные — точечный SWR по server actions (как в secret-sites-tab), никакого
 * router.refresh(). Жизненный цикл покупки (из доков API):
 *   PENDING (создана, деньги списаны) → «Получить код» → SUCCESS (креды) или
 *   ERROR; PENDING старше 20 минут без кода можно вернуть (REFUND).
 */

import { useMemo, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  ArrowDownUp,
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingCart,
  TriangleAlert,
  Wallet,
} from 'lucide-react'
import {
  secretGmtBuyAction,
  secretGmtCountriesAction,
  secretGmtProfileAction,
  secretGmtPurchasesAction,
  secretGmtRefundAction,
  secretGmtRequestCodeAction,
  secretGmtStatusAction,
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
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'

/* ------------------------------- Хелперы -------------------------------- */

function fmtMoney(m: GmtMoney): string {
  return `${m.amount} ${m.currency_code}`
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** PENDING старше 20 минут — по докам можно запрашивать возврат. */
function refundEligible(p: GmtPurchase): boolean {
  return (
    p.status === 'PENDING' &&
    !p.verification &&
    Date.now() - new Date(p.created_at).getTime() > 20 * 60 * 1000
  )
}

const STATUS_LABEL: Record<GmtPurchase['status'], string> = {
  PENDING: 'Ожидает код',
  SUCCESS: 'Готов',
  ERROR: 'Ошибка',
  REFUND: 'Возврат',
}

const STATUS_CLASS: Record<GmtPurchase['status'], string> = {
  PENDING: 'border-warning/40 text-warning',
  SUCCESS: 'border-success/40 text-success',
  ERROR: 'border-destructive/40 text-destructive',
  REFUND: 'border-border text-muted-foreground',
}

function CopyButton({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {
          toast.error('Не удалось скопировать')
        }
      }}
      aria-label={`Скопировать ${label}`}
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5" />
      )}
    </Button>
  )
}

/* ------------------------------ Компонент ------------------------------- */

export function SecretGmtTab() {
  const [pending, startTransition] = useTransition()
  const [buyTarget, setBuyTarget] = useState<GmtCountry | null>(null)
  const [countryFilter, setCountryFilter] = useState('')
  const [sortAsc, setSortAsc] = useState(true)
  const [revealId, setRevealId] = useState<number | null>(null)

  const { data: status } = useSWR('gmt-status', async () => {
    const res = await secretGmtStatusAction()
    return res.data ?? null
  })

  const configured = status?.configured ?? true

  const { data: profile, mutate: mutateProfile } = useSWR(
    configured ? 'gmt-profile' : null,
    async () => {
      const res = await secretGmtProfileAction()
      if (!res.ok) throw new Error(res.message)
      return res.data ?? null
    },
    { revalidateOnFocus: false },
  )

  const { data: countries, isLoading: countriesLoading } = useSWR(
    configured ? 'gmt-countries' : null,
    async () => {
      const res = await secretGmtCountriesAction('price_asc')
      if (!res.ok) throw new Error(res.message)
      return res.data ?? []
    },
    { revalidateOnFocus: false },
  )

  const {
    data: purchases,
    mutate: mutatePurchases,
    isLoading: purchasesLoading,
  } = useSWR(
    configured ? 'gmt-purchases' : null,
    async () => {
      const res = await secretGmtPurchasesAction()
      if (!res.ok) throw new Error(res.message)
      return res.data ?? []
    },
    // Пока есть PENDING-покупки, обновляем чаще: код может прийти в любой момент.
    { refreshInterval: (data) => (data?.some((p) => p.status === 'PENDING') ? 15_000 : 0) },
  )

  const visibleCountries = useMemo(() => {
    const list = countries ?? []
    const q = countryFilter.trim().toLowerCase()
    const filtered = q
      ? list.filter(
          (c) =>
            c.display_name.ru.toLowerCase().includes(q) ||
            c.display_name.en.toLowerCase().includes(q) ||
            c.country_code.toLowerCase().includes(q),
        )
      : list
    const sorted = [...filtered].sort(
      (a, b) => Number(a.price.amount) - Number(b.price.amount),
    )
    return sortAsc ? sorted : sorted.reverse()
  }, [countries, countryFilter, sortAsc])

  function confirmBuy() {
    const target = buyTarget
    if (!target) return
    setBuyTarget(null)
    startTransition(async () => {
      const res = await secretGmtBuyAction(target.country_code)
      if (res.ok && res.data) {
        toast.success(
          `Куплен номер ${res.data.phone_number ?? '—'} (${fmtMoney(res.data.price)})`,
        )
        void mutatePurchases()
        void mutateProfile()
      } else {
        toast.error(res.message)
      }
    })
  }

  function requestCode(p: GmtPurchase) {
    startTransition(async () => {
      const res = await secretGmtRequestCodeAction(p.id)
      if (res.ok && res.data) {
        const st = res.data.code_request.status
        if (st === 'success') toast.success('Код получен')
        else toast.info('Запрос кода отправлен — обычно занимает 5–30 секунд')
        void mutatePurchases()
      } else {
        toast.error(res.message)
      }
    })
  }

  function refund(p: GmtPurchase) {
    startTransition(async () => {
      const res = await secretGmtRefundAction(p.id)
      if (res.ok) {
        toast.success('Средства возвращены на баланс')
        void mutatePurchases()
        void mutateProfile()
      } else {
        toast.error(res.message)
      }
    })
  }

  if (status && !status.configured) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="flex flex-col gap-1">
            <h2 className="font-medium">Get My TG не настроен</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Добавьте <code className="font-mono">GMT_API_KEY</code> в env-файл
              на VPS и перезапустите панель. Ключ выдаёт официальный
              Telegram-бот сервиса. Как и SECRET_PANEL_PASSWORD, ключ живёт
              только в окружении — не в базе.
            </p>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Профиль и баланс */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
              <Wallet className="size-4 text-muted-foreground" />
            </div>
            <div>
              <h2 className="font-medium">Get My TG</h2>
              <p className="text-xs text-muted-foreground">
                {status?.health === 'ok'
                  ? 'Сервис на связи'
                  : status?.health === 'degraded'
                    ? 'Сервис деградирован'
                    : 'Статус неизвестен'}
              </p>
            </div>
          </div>
          {profile ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
              <span className="font-medium tabular-nums">
                {fmtMoney(profile.balance)}
              </span>
              <span className="text-muted-foreground">
                Скидка: {profile.discount.percent}%{' '}
                {profile.discount.level !== 'none'
                  ? `(${profile.discount.level})`
                  : ''}
              </span>
              <span className="text-muted-foreground">
                Покупок: {profile.statistics.total_purchases}
              </span>
            </div>
          ) : (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          )}
        </div>
      </Card>

      {/* Каталог стран */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-medium">Каталог</h3>
            <p className="text-xs text-muted-foreground">
              Цены с учётом персональной скидки
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Input
              value={countryFilter}
              onChange={(e) => setCountryFilter(e.target.value)}
              placeholder="Поиск страны…"
              className="h-8 w-44"
            />
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 bg-transparent"
              onClick={() => setSortAsc((v) => !v)}
            >
              <ArrowDownUp className="size-3.5" />
              {sortAsc ? 'Дешевле' : 'Дороже'}
            </Button>
          </div>
        </div>

        {countriesLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : visibleCountries.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={Search}
              title="Ничего не найдено"
              description="Попробуйте другой запрос или сбросьте фильтр."
            />
          </div>
        ) : (
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {visibleCountries.map((c) => (
              <div
                key={c.country_code}
                className={cn(
                  'flex items-center justify-between gap-2 rounded-md border border-border p-3',
                  !c.available && 'opacity-50',
                )}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="text-lg leading-none" aria-hidden>
                    {c.emoji}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {c.display_name.ru}
                    </p>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {fmtMoney(c.price)}
                      {typeof c.available_count === 'number'
                        ? ` · ${c.available_count} шт`
                        : ''}
                    </p>
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 shrink-0 gap-1 bg-transparent px-2 text-xs"
                  disabled={!c.available || pending}
                  onClick={() => setBuyTarget(c)}
                >
                  <ShoppingCart className="size-3" />
                  Купить
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Покупки */}
      <Card className="p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h3 className="font-medium">Покупки</h3>
            <p className="text-xs text-muted-foreground">
              PENDING → «Получить код» → готовые креды для входа
            </p>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => void mutatePurchases()}
          >
            <RefreshCw className="size-3.5" />
            Обновить
          </Button>
        </div>

        {purchasesLoading ? (
          <div className="flex justify-center py-10">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !purchases || purchases.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              icon={ShoppingCart}
              title="Покупок пока нет"
              description="Выберите страну в каталоге выше — номер появится здесь."
            />
          </div>
        ) : (
          <div className="mt-3 divide-y divide-border">
            {purchases.map((p) => (
              <div key={p.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-sm font-medium">
                    {p.phone_number ?? '№ не выдан'}
                  </span>
                  {p.phone_number ? (
                    <CopyButton value={p.phone_number} label="номер" />
                  ) : null}
                  <Badge variant="outline" className={STATUS_CLASS[p.status]}>
                    {STATUS_LABEL[p.status]}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {p.display_name.ru} · {fmtMoney(p.price)} ·{' '}
                    {fmtDate(p.created_at)}
                  </span>
                </div>

                {p.verification ? (
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
                    <span className="flex items-center gap-1.5">
                      <KeyRound className="size-3.5 text-muted-foreground" />
                      Код:{' '}
                      <span className="font-mono">
                        {revealId === p.id ? p.verification.code : '•••••'}
                      </span>
                      <CopyButton value={p.verification.code} label="код" />
                    </span>
                    <span className="flex items-center gap-1.5">
                      Пароль:{' '}
                      <span className="font-mono">
                        {revealId === p.id ? p.verification.password : '•••••'}
                      </span>
                      <CopyButton
                        value={p.verification.password}
                        label="пароль"
                      />
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-1.5 text-xs"
                      onClick={() =>
                        setRevealId((v) => (v === p.id ? null : p.id))
                      }
                    >
                      {revealId === p.id ? (
                        <EyeOff className="size-3" />
                      ) : (
                        <Eye className="size-3" />
                      )}
                      {revealId === p.id ? 'Скрыть' : 'Показать'}
                    </Button>
                  </div>
                ) : null}

                {p.status === 'PENDING' ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      size="sm"
                      className="h-7 gap-1.5 px-2.5 text-xs"
                      disabled={pending}
                      onClick={() => requestCode(p)}
                    >
                      {pending ? (
                        <Loader2 className="size-3 animate-spin" />
                      ) : (
                        <KeyRound className="size-3" />
                      )}
                      Получить код
                    </Button>
                    {refundEligible(p) ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 gap-1.5 bg-transparent px-2.5 text-xs"
                        disabled={pending}
                        onClick={() => refund(p)}
                      >
                        <RotateCcw className="size-3" />
                        Вернуть средства
                      </Button>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        Возврат доступен через 20 минут, если код не придёт
                      </span>
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Подтверждение покупки: деньги списываются сразу и безвозвратно
          (кроме сценария «код не пришёл за 20 минут»). */}
      <Dialog
        open={buyTarget !== null}
        onOpenChange={(open) => {
          if (!open) setBuyTarget(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Купить аккаунт</DialogTitle>
            <DialogDescription>
              {buyTarget
                ? `${buyTarget.emoji} ${buyTarget.display_name.ru} за ${fmtMoney(buyTarget.price)}. Баланс спишется сразу; код нужно запросить после покупки.`
                : ''}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBuyTarget(null)}>
              Отмена
            </Button>
            <Button onClick={confirmBuy} disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Купить
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
