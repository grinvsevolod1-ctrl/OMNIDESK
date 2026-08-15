'use client'

/**
 * God-панель, вкладка «API TG» — покупка Telegram-аккаунтов через Get My TG
 * (docs.getmytg.com). Часть скрытой панели: подчиняется инвариантам AGENTS.md
 * §4 (обычная админка и Admin AI о вкладке не знают).
 *
 * Три секции: Каталог (страны, скидка, покупка 1 шт / опт), Покупки
 * (статусы, креды, возврат, пагинация) и Опт (архивы bulk-закупок).
 * Данные — точечный SWR по server actions, в БД панели НИЧЕГО не пишется;
 * ID bulk-закупок панель помнит в localStorage браузера (у API нет списка).
 *
 * Жизненный цикл покупки (из доков API):
 *   PENDING (создана, деньги списаны) → «Получить код» → SUCCESS (креды) или
 *   ERROR; PENDING старше 20 минут без кода можно вернуть (REFUND).
 * Bulk: PENDING → архив готовится → SUCCESS (ZIP через god-роут
 * /wijegniwjgwjog/api/gmt-bulk-download — ключ API не попадает в браузер).
 */

import { useCallback, useMemo, useState, useTransition } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  ArrowDownUp,
  ArrowLeft,
  ArrowRight,
  BadgePercent,
  Boxes,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Loader2,
  Package,
  RefreshCw,
  RotateCcw,
  Search,
  ShoppingCart,
  TriangleAlert,
  Users,
  Wallet,
  Zap,
} from 'lucide-react'
import {
  secretGmtBulkBuyAction,
  secretGmtBulkStatusAction,
  secretGmtBuyAction,
  secretGmtCountriesAction,
  secretGmtCountryDetailsAction,
  secretGmtProfileAction,
  secretGmtPurchasesAction,
  secretGmtRefundAction,
  secretGmtRequestCodeAction,
  secretGmtStatusAction,
  type GmtBulkPurchase,
  type GmtCountry,
  type GmtMoney,
  type GmtProfile,
  type GmtPurchase,
  type GmtPurchaseStatus,
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

/* ------------------------------- Хелперы -------------------------------- */

function fmtMoney(m: GmtMoney | null | undefined): string {
  if (!m) return '—'
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

/** Сколько минут осталось до права на возврат (PENDING > 20 мин, из доков). */
function refundEtaMinutes(p: GmtPurchase): number {
  const elapsed = Date.now() - new Date(p.created_at).getTime()
  return Math.max(0, Math.ceil(20 - elapsed / 60_000))
}

const STATUS_LABEL: Record<GmtPurchaseStatus, string> = {
  PENDING: 'Ожидает код',
  SUCCESS: 'Готов',
  ERROR: 'Ошибка',
  REFUND: 'Возврат',
}

const STATUS_CLASS: Record<GmtPurchaseStatus, string> = {
  PENDING: 'border-warning/40 text-warning',
  SUCCESS: 'border-success/40 text-success',
  ERROR: 'border-destructive/40 text-destructive',
  REFUND: 'border-border text-muted-foreground',
}

const TAG_META: Record<string, { label: string; cls: string }> = {
  HIGH_QUALITY: { label: 'Топ качество', cls: 'border-primary/40 text-primary' },
  HIGH_DEMAND: { label: 'Высокий спрос', cls: 'border-warning/40 text-warning' },
}

function StatusBadge({ status }: { status: GmtPurchaseStatus }) {
  return (
    <Badge variant="outline" className={STATUS_CLASS[status]}>
      {status === 'PENDING' ? (
        <Loader2 className="mr-1 size-3 animate-spin" aria-hidden />
      ) : null}
      {STATUS_LABEL[status]}
    </Badge>
  )
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

/* --------------------- Память bulk-ID (localStorage) -------------------- */

/**
 * У API нет эндпоинта «список bulk-закупок» — только статус по ID. Панель
 * помнит созданные ID в localStorage браузера (НЕ в БД — инвариант вкладки),
 * плюс любой ID можно добавить вручную в секции «Опт».
 */
const BULK_IDS_KEY = 'god-gmt-bulk-ids'

function readBulkIds(): number[] {
  try {
    const raw = localStorage.getItem(BULK_IDS_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr)
      ? arr.filter((n): n is number => Number.isInteger(n) && n > 0)
      : []
  } catch {
    return []
  }
}

function rememberBulkId(id: number) {
  try {
    const ids = readBulkIds()
    if (!ids.includes(id)) {
      // Свежие сверху, максимум 50 — старые архивы живут у сервиса.
      localStorage.setItem(
        BULK_IDS_KEY,
        JSON.stringify([id, ...ids].slice(0, 50)),
      )
    }
  } catch {
    /* localStorage недоступен — не критично */
  }
}

/* ------------------------------ Компонент ------------------------------- */

type Section = 'catalog' | 'purchases' | 'bulk'

export function SecretGmtTab() {
  const [section, setSection] = useState<Section>('catalog')

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

  if (status && !status.configured) {
    return (
      <Card className="p-6">
        <div className="flex items-start gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="flex flex-col gap-2">
            <h2 className="font-medium">Get My TG не настроен</h2>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Ключ API живёт только в env-переменной{' '}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                GMT_API_KEY
              </code>{' '}
              (как SECRET_PANEL_PASSWORD — не в базе). Ключ выдаёт официальный
              Telegram-бот сервиса.
            </p>
            <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed text-muted-foreground">
              {`# На VPS добавьте в .env:
GMT_API_KEY=ваш_ключ
# И перезапустите панель:
pm2 restart panel`}
            </pre>
          </div>
        </div>
      </Card>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <ProfileHeader
        profile={profile ?? null}
        health={status?.health ?? 'unreachable'}
        onRefresh={() => void mutateProfile()}
      />

      {/* Переключатель секций */}
      <div className="flex w-fit items-center gap-1 rounded-lg border border-border bg-muted/30 p-1">
        {(
          [
            { id: 'catalog', label: 'Каталог', icon: ShoppingCart },
            { id: 'purchases', label: 'Покупки', icon: Package },
            { id: 'bulk', label: 'Опт', icon: Boxes },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setSection(t.id)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors',
              section === t.id
                ? 'bg-background font-medium text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <t.icon className="size-3.5" aria-hidden />
            {t.label}
          </button>
        ))}
      </div>

      {section === 'catalog' ? (
        <CatalogSection
          balance={profile?.balance ?? null}
          onPurchased={() => {
            void mutateProfile()
            setSection('purchases')
          }}
          onBulkCreated={() => {
            void mutateProfile()
            setSection('bulk')
          }}
        />
      ) : null}
      {section === 'purchases' ? (
        <PurchasesSection onBalanceChanged={() => void mutateProfile()} />
      ) : null}
      {section === 'bulk' ? <BulkSection /> : null}
    </div>
  )
}

/* ---------------------------- Шапка профиля ----------------------------- */

function ProfileHeader({
  profile,
  health,
  onRefresh,
}: {
  profile: GmtProfile | null
  health: 'ok' | 'degraded' | 'unreachable'
  onRefresh: () => void
}) {
  const healthMeta =
    health === 'ok'
      ? { cls: 'bg-success', label: 'API на связи' }
      : health === 'degraded'
        ? { cls: 'bg-warning', label: 'API деградирован' }
        : { cls: 'bg-destructive', label: 'API недоступен' }

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-md border border-border bg-muted/40">
            <ShoppingCart className="size-4 text-muted-foreground" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h2 className="font-medium">Get My TG</h2>
              <span
                className={cn('inline-block size-2 rounded-full', healthMeta.cls)}
                title={healthMeta.label}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {profile?.telegram_username
                ? `@${profile.telegram_username}`
                : 'Магазин Telegram-аккаунтов'}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 bg-transparent"
          onClick={onRefresh}
        >
          <RefreshCw className="size-3.5" />
          Обновить
        </Button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          icon={Wallet}
          label="Баланс"
          value={profile ? fmtMoney(profile.balance) : null}
          accent
        />
        <StatTile
          icon={BadgePercent}
          label={`Скидка${profile && profile.discount.level !== 'none' ? ` · ${profile.discount.level}` : ''}`}
          value={profile ? `${profile.discount.percent}%` : null}
        />
        <StatTile
          icon={Package}
          label="Всего покупок"
          value={profile ? String(profile.statistics.total_purchases) : null}
        />
        <StatTile
          icon={Users}
          label={`Рефералы · ${profile?.referral.referrals_count ?? 0}`}
          value={profile ? fmtMoney(profile.referral.balance) : null}
        />
      </div>
    </Card>
  )
}

function StatTile({
  icon: Icon,
  label,
  value,
  accent = false,
}: {
  icon: typeof Wallet
  label: string
  value: string | null
  accent?: boolean
}) {
  return (
    <div
      className={cn(
        'flex flex-col gap-1 rounded-lg border p-3',
        accent ? 'border-primary/30 bg-primary/5' : 'border-border bg-muted/20',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="size-3.5" aria-hidden />
        {label}
      </div>
      {value === null ? (
        <Skeleton className="h-6 w-20" />
      ) : (
        <span
          className={cn(
            'text-lg font-semibold tabular-nums',
            accent && 'text-primary',
          )}
        >
          {value}
        </span>
      )}
    </div>
  )
}

/* ------------------------------- Каталог -------------------------------- */

function CatalogSection({
  balance,
  onPurchased,
  onBulkCreated,
}: {
  balance: GmtMoney | null
  onPurchased: () => void
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
  onPurchased: () => void
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
            `Куплен номер ${res.data.phone_number ?? '—'} (${fmtMoney(res.data.price)}) — запросите код`,
          )
          onClose()
          onPurchased()
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

/* ------------------------------- Покупки -------------------------------- */

const FILTERS: { id: GmtPurchaseStatus | 'ALL'; label: string }[] = [
  { id: 'ALL', label: 'Все' },
  { id: 'PENDING', label: 'Ожидают' },
  { id: 'SUCCESS', label: 'Готовые' },
  { id: 'ERROR', label: 'Ошибки' },
  { id: 'REFUND', label: 'Возвраты' },
]

function PurchasesSection({
  onBalanceChanged,
}: {
  onBalanceChanged: () => void
}) {
  const [filter, setFilter] = useState<GmtPurchaseStatus | 'ALL'>('ALL')
  const [page, setPage] = useState(1)

  const { data, isLoading, mutate } = useSWR(
    ['gmt-purchases', filter, page],
    async () => {
      const res = await secretGmtPurchasesAction(
        filter === 'ALL' ? undefined : filter,
        page,
      )
      if (!res.ok) throw new Error(res.message)
      return res.data
    },
    {
      keepPreviousData: true,
      // Пока в выборке есть PENDING — код может прийти в любой момент.
      refreshInterval: (latest) =>
        latest?.items.some((p) => p.status === 'PENDING') ? 15_000 : 0,
    },
  )

  const items = data?.items ?? []
  const pagination = data?.pagination

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-medium">Покупки</h3>
          <p className="text-xs text-muted-foreground">
            PENDING → «Получить код» → готовые креды для входа
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-0.5 rounded-md border border-border p-0.5">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => {
                  setFilter(f.id)
                  setPage(1)
                }}
                className={cn(
                  'rounded px-2 py-1 text-xs transition-colors',
                  filter === f.id
                    ? 'bg-muted font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 gap-1.5"
            onClick={() => void mutate()}
          >
            <RefreshCw className="size-3.5" />
            Обновить
          </Button>
        </div>
      </div>

      {isLoading && items.length === 0 ? (
        <div className="mt-3 flex flex-col gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 rounded-md" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="mt-4">
          <EmptyState
            icon={Package}
            title="Покупок нет"
            description="Выберите страну в каталоге — купленный номер появится здесь."
          />
        </div>
      ) : (
        <div className="mt-3 divide-y divide-border">
          {items.map((p) => (
            <PurchaseRow
              key={p.id}
              purchase={p}
              onChanged={() => {
                void mutate()
                onBalanceChanged()
              }}
            />
          ))}
        </div>
      )}

      {pagination && pagination.total_pages > 1 ? (
        <div className="mt-3 flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="h-7 bg-transparent px-2"
            disabled={!pagination.has_previous}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            aria-label="Предыдущая страница"
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <span className="text-xs tabular-nums text-muted-foreground">
            {pagination.current_page} / {pagination.total_pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            className="h-7 bg-transparent px-2"
            disabled={!pagination.has_next}
            onClick={() => setPage((p) => p + 1)}
            aria-label="Следующая страница"
          >
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      ) : null}
    </Card>
  )
}

function PurchaseRow({
  purchase: p,
  onChanged,
}: {
  purchase: GmtPurchase
  onChanged: () => void
}) {
  const [pending, startTransition] = useTransition()
  const [revealed, setRevealed] = useState(false)
  const eta = refundEtaMinutes(p)
  const canRefund = p.status === 'PENDING' && !p.verification && eta === 0

  function requestCode() {
    startTransition(async () => {
      const res = await secretGmtRequestCodeAction(p.id)
      if (res.ok && res.data) {
        const st = res.data.code_request.status
        if (st === 'success') toast.success('Код получен')
        else toast.info('Запрос кода отправлен — обычно занимает 5–30 секунд')
      } else if (res.message.toLowerCase().includes('conflict')) {
        // Повторный request-code даёт conflict — просто перечитываем детали.
        toast.info('Код уже был запрошен — обновляю данные')
      } else {
        toast.error(res.message)
      }
      onChanged()
    })
  }

  function refund() {
    if (
      !window.confirm(
        `Вернуть покупку №${p.id}? Деньги вернутся на баланс Get My TG.`,
      )
    )
      return
    startTransition(async () => {
      const res = await secretGmtRefundAction(p.id)
      if (res.ok) toast.success('Средства возвращены на баланс')
      else toast.error(res.message)
      onChanged()
    })
  }

  return (
    <div className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono text-xs text-muted-foreground">#{p.id}</span>
        <span className="font-mono text-sm font-medium">
          {p.phone_number ?? '№ не выдан'}
        </span>
        {p.phone_number ? (
          <CopyButton value={p.phone_number} label="номер" />
        ) : null}
        <StatusBadge status={p.status} />
        {p.purchase_type === 'BULK' ? (
          <Badge variant="outline" className="border-border text-muted-foreground">
            Опт
          </Badge>
        ) : null}
        <span className="text-xs text-muted-foreground">
          {p.display_name.ru} · {fmtMoney(p.price)} · {fmtDate(p.created_at)}
        </span>
      </div>

      {p.verification ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-sm">
          <span className="flex items-center gap-1.5">
            <KeyRound className="size-3.5 text-success" />
            Код:{' '}
            <span className="font-mono font-semibold tabular-nums">
              {revealed ? p.verification.code : '•••••'}
            </span>
            <CopyButton value={p.verification.code} label="код" />
          </span>
          {p.verification.password ? (
            <span className="flex items-center gap-1.5">
              Пароль 2FA:{' '}
              <span className="font-mono font-semibold">
                {revealed ? p.verification.password : '••••••••'}
              </span>
              <CopyButton value={p.verification.password} label="пароль" />
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="sm"
            className="h-6 gap-1 px-1.5 text-xs"
            onClick={() => setRevealed((v) => !v)}
          >
            {revealed ? (
              <EyeOff className="size-3" />
            ) : (
              <Eye className="size-3" />
            )}
            {revealed ? 'Скрыть' : 'Показать'}
          </Button>
        </div>
      ) : null}

      {p.status === 'PENDING' ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            className="h-7 gap-1.5 px-2.5 text-xs"
            disabled={pending}
            onClick={requestCode}
          >
            {pending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <KeyRound className="size-3" />
            )}
            Получить код
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 gap-1.5 bg-transparent px-2.5 text-xs"
            disabled={!canRefund || pending}
            onClick={refund}
            title={
              canRefund
                ? 'Вернуть деньги на баланс'
                : `Возврат доступен через ${eta} мин (правило 20 минут)`
            }
          >
            <RotateCcw className="size-3" />
            {canRefund ? 'Вернуть средства' : `Возврат через ${eta} мин`}
          </Button>
        </div>
      ) : null}
    </div>
  )
}

/* --------------------------------- Опт ---------------------------------- */

function BulkSection() {
  // Ленивый инициализатор безопасен: секция монтируется только по клику
  // на переключатель (после гидрации), SSR-рассинхрона быть не может.
  const [ids, setIds] = useState<number[]>(() =>
    typeof window === 'undefined' ? [] : readBulkIds(),
  )
  const [lookup, setLookup] = useState('')

  const addLookup = useCallback(() => {
    const id = Number(lookup.trim())
    if (!Number.isInteger(id) || id < 1) {
      toast.error('Введите числовой ID закупки')
      return
    }
    rememberBulkId(id)
    setIds(readBulkIds())
    setLookup('')
  }, [lookup])

  return (
    <div className="flex flex-col gap-3">
      <Card className="p-5">
        <h3 className="font-medium">Оптовые закупки</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Создаются из каталога (режим «Опт»). Панель помнит созданные ID в
          этом браузере; любой ID можно добавить вручную. Архив (ZIP с
          сессиями) скачивается после готовности.
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Input
            value={lookup}
            onChange={(e) => setLookup(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              )
                addLookup()
            }}
            placeholder="ID закупки, например 123"
            inputMode="numeric"
            className="h-8 w-48 tabular-nums"
          />
          <Button
            size="sm"
            variant="outline"
            className="h-8 bg-transparent"
            onClick={addLookup}
          >
            Добавить
          </Button>
        </div>
      </Card>

      {ids.length === 0 ? (
        <EmptyState
          icon={Boxes}
          title="Оптовых закупок нет"
          description="Создайте закупку из каталога: кнопка «Купить» → режим «Опт»."
        />
      ) : (
        <div className="flex flex-col gap-2">
          {ids.map((id) => (
            <BulkCard key={id} id={id} />
          ))}
        </div>
      )}
    </div>
  )
}

function BulkCard({ id }: { id: number }) {
  const { data, isLoading, error, mutate } = useSWR(
    ['gmt-bulk', id],
    async () => {
      const res = await secretGmtBulkStatusAction(id)
      if (!res.ok) throw new Error(res.message)
      return res.data as GmtBulkPurchase
    },
    {
      // Опрос каждые 20с, пока архив готовится.
      refreshInterval: (latest) => (latest?.status === 'PENDING' ? 20_000 : 0),
      revalidateOnFocus: false,
    },
  )

  if (isLoading && !data) {
    return <Skeleton className="h-20 rounded-md" />
  }

  if (error || !data) {
    return (
      <div className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 p-3">
        <span className="text-sm text-muted-foreground">
          Закупка №{id}: не удалось загрузить (чужой или несуществующий ID)
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          onClick={() => void mutate()}
          aria-label="Повторить загрузку"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="font-mono text-xs text-muted-foreground">
            №{data.bulk_purchase_id}
          </span>
          <span className="text-sm font-medium">
            {data.country_code} · {data.quantity} шт
          </span>
          <span className="text-xs tabular-nums text-muted-foreground">
            {fmtMoney(data.price_per_account)}/шт · итого{' '}
            {fmtMoney(data.total_price)}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {fmtDate(data.created_at)}
          </span>
          <StatusBadge status={data.status} />
        </div>
      </div>

      {data.status === 'SUCCESS' && data.item ? (
        <div>
          {/* Скачивание через god-роут: ключ API остаётся на сервере */}
          <a
            href={`/wijegniwjgwjog/api/gmt-bulk-download?id=${data.bulk_purchase_id}`}
            className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            <Download className="size-3" aria-hidden />
            Скачать архив ({data.item.quantity} акк.)
          </a>
        </div>
      ) : null}
      {data.status === 'PENDING' ? (
        <p className="text-xs text-muted-foreground">
          Архив готовится — статус обновляется автоматически каждые 20 секунд.
        </p>
      ) : null}
    </div>
  )
}
