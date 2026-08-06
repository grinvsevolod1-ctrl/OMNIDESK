'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { ClipboardList, Loader2, MapPin, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  findCuratorsByCityAction,
  getLeadCardAction,
  saveLeadCardAction,
} from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { CuratorWithLoad } from '@/lib/data/lead-cards'

/**
 * «Карточка лида» — кнопка рядом с ИИ.
 * Открывает фиксированную панель, прикреплённую к краю экрана до закрытия
 * (не уезжает при скролле диалога). На мобиле — почти full-width снизу,
 * на десктопе — широкая правая колонка.
 */
export function LeadCardPanel({
  conversationId,
  defaults,
}: {
  conversationId: string
  defaults?: {
    fullName?: string
    phone?: string
    telegramUsername?: string
    city?: string
  }
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [fullName, setFullName] = useState(defaults?.fullName ?? '')
  const [phone, setPhone] = useState(defaults?.phone ?? '')
  const [telegramUsername, setTelegramUsername] = useState(
    defaults?.telegramUsername ?? '',
  )
  const [city, setCity] = useState(defaults?.city ?? '')
  const [address, setAddress] = useState('')
  const [vacancy, setVacancy] = useState('')
  const [curatorId, setCuratorId] = useState<string | null>(null)
  const [curators, setCurators] = useState<CuratorWithLoad[]>([])
  const [searching, setSearching] = useState(false)
  const [transferredAt, setTransferredAt] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    const card = await getLeadCardAction(conversationId)
    if (card) {
      setFullName(card.fullName || defaults?.fullName || '')
      setPhone(card.phone || defaults?.phone || '')
      setTelegramUsername(
        card.telegramUsername || defaults?.telegramUsername || '',
      )
      setCity(card.city || defaults?.city || '')
      setAddress(card.address)
      setVacancy(card.vacancy)
      setCuratorId(card.curatorId)
      setTransferredAt(card.transferredAt)
    }
    setLoaded(true)
  }, [conversationId, defaults])

  useEffect(() => {
    if (open && !loaded) void load()
  }, [open, loaded, load])

  // Reset load flag when conversation changes.
  useEffect(() => {
    setLoaded(false)
    setOpen(false)
  }, [conversationId])

  useEffect(() => {
    if (!open) return
    const q = city.trim()
    if (q.length < 2) {
      setCurators([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      setSearching(true)
      void findCuratorsByCityAction(q).then((list) => {
        if (!cancelled) {
          setCurators(list)
          setSearching(false)
        }
      })
    }, 250)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [city, open])

  // Lock body scroll while panel is open on mobile.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  function save(transfer: boolean) {
    startTransition(async () => {
      const res = await saveLeadCardAction({
        conversationId,
        fullName,
        phone,
        telegramUsername,
        city,
        address,
        vacancy,
        curatorId: transfer ? curatorId : null,
      })
      if (res.ok) {
        toast.success(res.message)
        if (transfer) {
          setTransferredAt(new Date().toISOString())
          setOpen(false)
        }
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <>
      <Button
        variant={transferredAt ? 'default' : 'ghost'}
        size="sm"
        className="gap-1.5"
        title="Карточка лида"
        aria-label="Карточка лида"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ClipboardList className="size-4" />
        <span className="hidden sm:inline">Карточка</span>
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 flex justify-end">
          {/* Dim backdrop — click closes */}
          <button
            type="button"
            className="absolute inset-0 bg-black/30 supports-backdrop-filter:backdrop-blur-[2px]"
            aria-label="Закрыть карточку"
            onClick={() => setOpen(false)}
          />

          {/* Fixed panel pinned to the viewport edge */}
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Карточка лида"
            className={cn(
              'relative z-10 flex h-full w-full flex-col bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10',
              'animate-in slide-in-from-bottom-4 duration-200 sm:slide-in-from-right-4',
              // Mobile: full width bottom sheet feel; desktop: comfortable 28rem panel
              'max-sm:mt-auto max-sm:h-[min(92dvh,100%)] max-sm:rounded-t-2xl',
              'sm:ml-auto sm:w-[min(28rem,100vw)] sm:max-w-[28rem]',
            )}
          >
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
              <div className="min-w-0">
                <p className="text-base font-semibold tracking-tight">
                  Карточка лида
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Данные для передачи куратору
                </p>
              </div>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setOpen(false)}
                aria-label="Закрыть"
              >
                <X className="size-4" />
              </Button>
            </header>

            <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5">
              <Field label="ФИО" required>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Иван Иванов"
                  autoComplete="name"
                />
              </Field>
              <div className="grid gap-3.5 sm:grid-cols-2">
                <Field label="Телефон">
                  <Input
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+7…"
                    inputMode="tel"
                  />
                </Field>
                <Field label="Telegram">
                  <Input
                    value={telegramUsername}
                    onChange={(e) => setTelegramUsername(e.target.value)}
                    placeholder="@username"
                  />
                </Field>
              </div>
              <Field label="Город" required>
                <Input
                  value={city}
                  onChange={(e) => {
                    setCity(e.target.value)
                    setCuratorId(null)
                  }}
                  placeholder="Москва"
                />
              </Field>
              <Field label="Адрес">
                <Input
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Улица, дом"
                />
              </Field>
              <Field label="Вакансия / должность">
                <Input
                  value={vacancy}
                  onChange={(e) => setVacancy(e.target.value)}
                  placeholder="Курьер, менеджер…"
                />
              </Field>

              {city.trim().length >= 2 ? (
                <div className="flex flex-col gap-2">
                  <span className="text-xs font-medium text-muted-foreground">
                    Кураторы по городу
                  </span>
                  {searching ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Ищем…
                    </p>
                  ) : curators.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                      Нет кураторов для «{city.trim()}»
                    </p>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {curators.map((c) => (
                        <button
                          key={c.id}
                          type="button"
                          onClick={() => setCuratorId(c.id)}
                          className={cn(
                            'flex items-center justify-between rounded-lg border px-3 py-2.5 text-left text-sm transition-colors',
                            curatorId === c.id
                              ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                              : 'border-border hover:bg-muted',
                          )}
                        >
                          <span className="font-medium">{c.name}</span>
                          <span className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span className="flex items-center gap-1">
                              <MapPin className="size-3" />
                              {c.city}
                            </span>
                            <span
                              className="rounded bg-muted px-1.5 py-0.5 text-[10px]"
                              title="Активных лидов у куратора"
                            >
                              {c.activeLeads} лид.
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : null}

              {transferredAt ? (
                <p className="rounded-lg bg-emerald-500/10 px-3 py-2.5 text-xs text-emerald-700 dark:text-emerald-400">
                  Передано{' '}
                  {new Date(transferredAt).toLocaleString('ru-RU', {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                </p>
              ) : null}
            </div>

            <footer className="flex shrink-0 gap-2 border-t border-border bg-muted/30 p-3 sm:p-4">
              <Button
                variant="outline"
                className="flex-1"
                disabled={pending}
                onClick={() => save(false)}
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : null}
                Сохранить
              </Button>
              <Button
                className="flex-1 gap-1.5"
                disabled={pending || !curatorId}
                onClick={() => save(true)}
              >
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Send className="size-4" />
                )}
                Передать
              </Button>
            </footer>
          </aside>
        </div>
      ) : null}
    </>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs">
        {label}
        {required ? <span className="text-destructive"> *</span> : null}
      </Label>
      {children}
    </div>
  )
}
