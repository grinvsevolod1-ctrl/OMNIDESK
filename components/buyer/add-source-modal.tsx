'use client'

/**
 * Огромная модалка добавления источника трафика. Два шага:
 *   1) Каталог мировых площадок: поиск + категории + красивые лого-блоки.
 *   2) Настройка выбранной платформы: название, валюта, кабинет, окно дня.
 *
 * Единый путь создания источника в новой модели — байер создаёт его сам отсюда.
 */

import { useMemo, useState, useTransition } from 'react'
import { ArrowLeft, Check, Loader2, Search, Sparkles, X } from 'lucide-react'
import { toast } from 'sonner'
import { createBuyerSourceAction } from '@/app/actions/buyer'
import { PlatformLogo } from '@/components/buyer/platform-logo'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  catalogByCategory,
  searchCatalog,
  SOURCE_CURRENCIES_HINT,
  type CatalogPlatform,
} from '@/lib/traffic-source-catalog'
import { cn } from '@/lib/utils'

const CURRENCIES = ['RUB', 'USD', 'EUR', 'USDT'] as const

/** «ЧЧ:ММ» → минуты для инпутов времени окна дня. */
function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

function PlatformCard({
  platform,
  onSelect,
}: {
  platform: CatalogPlatform
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'group relative flex flex-col items-center gap-3 rounded-2xl border border-border bg-card p-4',
        'text-center transition-all hover:-translate-y-0.5 hover:border-foreground/20 hover:shadow-lg',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      )}
      style={{ ['--brand' as string]: `#${platform.hex}` }}
    >
      {/* Мягкое бренд-свечение сверху карточки при наведении */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-16 rounded-t-2xl opacity-0 transition-opacity group-hover:opacity-100"
        style={{
          background: `radial-gradient(ellipse at top, #${platform.hex}22, transparent 70%)`,
        }}
      />
      <PlatformLogo platform={platform} size={48} />
      <span className="line-clamp-2 text-sm font-medium leading-tight">
        {platform.name}
      </span>
    </button>
  )
}

export function AddSourceModal({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated?: () => void
}) {
  const [q, setQ] = useState('')
  const [selected, setSelected] = useState<CatalogPlatform | null>(null)
  const [pending, startTransition] = useTransition()

  // Форма настройки выбранной платформы.
  const [name, setName] = useState('')
  const [currency, setCurrency] = useState<string>('RUB')
  const [account, setAccount] = useState('')
  const [notes, setNotes] = useState('')
  const [dayStart, setDayStart] = useState('09:00')
  const [dayEnd, setDayEnd] = useState('18:00')

  const groups = useMemo(() => catalogByCategory(searchCatalog(q)), [q])
  const found = useMemo(() => searchCatalog(q).length, [q])

  function pick(p: CatalogPlatform) {
    setSelected(p)
    setName(p.key === 'custom' ? '' : p.name)
    setCurrency(p.defaultCurrency)
    setAccount('')
    setNotes('')
  }

  function reset() {
    setSelected(null)
    setQ('')
    setName('')
    setAccount('')
    setNotes('')
    setDayStart('09:00')
    setDayEnd('18:00')
  }

  function handleClose(v: boolean) {
    if (!v) reset()
    onOpenChange(v)
  }

  function submit() {
    if (!selected) return
    if (!name.trim()) {
      toast.error('Укажите название источника.')
      return
    }
    const start = timeToMinutes(dayStart)
    const end = timeToMinutes(dayEnd)
    if (start >= end) {
      toast.error('Начало дня должно быть раньше конца.')
      return
    }
    startTransition(async () => {
      try {
        await createBuyerSourceAction({
          name: name.trim(),
          platformKey: selected.key,
          currency,
          externalAccount: account.trim(),
          notes: notes.trim() || null,
          dayStart: start,
          dayEnd: end,
        })
        toast.success('Источник добавлен.')
        handleClose(false)
        onCreated?.()
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Не удалось добавить источник.')
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="flex h-[88vh] max-h-[860px] w-[min(96vw,1100px)] max-w-none flex-col gap-0 overflow-hidden p-0"
        showCloseButton={false}
      >
        {!selected ? (
          <>
            {/* Шапка каталога */}
            <DialogHeader className="space-y-3 border-b border-border px-6 pb-4 pt-6">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <DialogTitle className="flex items-center gap-2 text-xl">
                    <Sparkles className="size-5 text-primary" />
                    Добавить источник трафика
                  </DialogTitle>
                  <DialogDescription>
                    Выберите рекламную площадку — {found} доступно. Затем настроите
                    учёт и получите полный контроль бюджета и трат.
                  </DialogDescription>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => handleClose(false)}
                  aria-label="Закрыть"
                >
                  <X className="size-5" />
                </Button>
              </div>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  autoFocus
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Поиск: Яндекс, Google, VK, Telegram, TikTok…"
                  className="h-11 pl-9 text-base"
                />
              </div>
            </DialogHeader>

            {/* Каталог по категориям */}
            <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
              {groups.length === 0 ? (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-muted-foreground">
                  <Search className="size-8 opacity-40" />
                  <p className="text-sm">
                    Ничего не найдено. Попробуйте другой запрос или выберите
                    «Свой источник».
                  </p>
                </div>
              ) : (
                <div className="space-y-7">
                  {groups.map((group) => (
                    <section key={group.category}>
                      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                        {group.label}
                      </h3>
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
                        {group.items.map((p) => (
                          <PlatformCard
                            key={p.key}
                            platform={p}
                            onSelect={() => pick(p)}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <>
            {/* Шаг настройки выбранной платформы */}
            <DialogHeader className="space-y-0 border-b border-border px-6 pb-4 pt-6">
              <div className="flex items-center gap-3">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSelected(null)}
                  aria-label="Назад к каталогу"
                >
                  <ArrowLeft className="size-5" />
                </Button>
                <PlatformLogo platform={selected} size={44} />
                <div className="min-w-0">
                  <DialogTitle className="truncate text-lg">
                    {selected.name}
                  </DialogTitle>
                  <DialogDescription>Настройка учёта источника</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-6 py-6">
              <div className="grid gap-5 sm:grid-cols-2">
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="src-name">Название источника</Label>
                  <Input
                    id="src-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Напр. Яндекс Директ — поиск РФ"
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="src-currency">Валюта учёта</Label>
                  <select
                    id="src-currency"
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                  >
                    {CURRENCIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-muted-foreground">
                    {SOURCE_CURRENCIES_HINT}
                  </p>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="src-account">Кабинет / логин</Label>
                  <Input
                    id="src-account"
                    value={account}
                    onChange={(e) => setAccount(e.target.value)}
                    placeholder="ID кабинета или логин"
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="src-day-start">Начало дня (МСК)</Label>
                  <Input
                    id="src-day-start"
                    type="time"
                    value={dayStart}
                    onChange={(e) => setDayStart(e.target.value)}
                    className="h-10"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="src-day-end">Конец дня (МСК)</Label>
                  <Input
                    id="src-day-end"
                    type="time"
                    value={dayEnd}
                    onChange={(e) => setDayEnd(e.target.value)}
                    className="h-10"
                  />
                </div>
                <div className="space-y-2 sm:col-span-2">
                  <Label htmlFor="src-notes">Заметки</Label>
                  <Textarea
                    id="src-notes"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Гео, кампании, особенности…"
                    rows={3}
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-3 border-t border-border px-6 py-4">
              <Button variant="ghost" onClick={() => setSelected(null)}>
                Назад
              </Button>
              <Button onClick={submit} disabled={pending} className="min-w-36">
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Check className="size-4" />
                )}
                Добавить источник
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
