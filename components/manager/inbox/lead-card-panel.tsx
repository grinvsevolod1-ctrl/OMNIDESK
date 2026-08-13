'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import useSWR from 'swr'
import { ClipboardList, Loader2, MapPin, Send, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  addLeadCommentAction,
  findCuratorsByCityAction,
  getLeadCardAction,
  getLeadCardDetailAction,
  saveLeadCardAction,
} from '@/app/actions/lead-cards'
import { LeadAttachments } from '@/components/shared/lead-attachments'
import { LeadHistoryEvent } from '@/components/shared/lead-history-event'
import { LeadStatusBadge } from '@/components/curator/lead-status-badge'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { leadStatusLabel } from '@/lib/lead-status'
import { APP_TIME_ZONE } from '@/lib/time'
import { cn } from '@/lib/utils'
import { CityInput } from '@/components/shared/city-input'
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
  onBrowseMedia,
}: {
  conversationId: string
  defaults?: {
    fullName?: string
    phone?: string
    telegramUsername?: string
    telegramId?: string
    city?: string
  }
  /** Телеграм-стиль навигация по кружкам/фото диалога для прикрепления. */
  onBrowseMedia?: (kind: 'video_note' | 'photo', leadCardId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [cardId, setCardId] = useState<string | null>(null)
  const [freeComment, setFreeComment] = useState('')
  const [fullName, setFullName] = useState(defaults?.fullName ?? '')
  const [phone, setPhone] = useState(defaults?.phone ?? '')
  const [telegramUsername, setTelegramUsername] = useState(
    defaults?.telegramUsername ?? '',
  )
  const [telegramId, setTelegramId] = useState(defaults?.telegramId ?? '')
  const [city, setCity] = useState(defaults?.city ?? '')
  const [address, setAddress] = useState('')
  const [vacancy, setVacancy] = useState('')
  const [curatorId, setCuratorId] = useState<string | null>(null)
  const [transferredAt, setTransferredAt] = useState<string | null>(null)

  const load = useCallback(async () => {
    const card = await getLeadCardAction(conversationId)
    if (card) {
      setCardId(card.id)
      setFullName(card.fullName || defaults?.fullName || '')
      setPhone(card.phone || defaults?.phone || '')
      setTelegramUsername(
        card.telegramUsername || defaults?.telegramUsername || '',
      )
      setTelegramId(card.telegramId || defaults?.telegramId || '')
      setCity(card.city || defaults?.city || '')
      setAddress(card.address)
      setVacancy(card.vacancy)
      setCuratorId(card.curatorId)
      setTransferredAt(card.transferredAt)
    } else {
      // No card for this contact yet — make sure the form shows THIS
      // conversation's defaults, never leftovers from a previous thread.
      setCardId(null)
      setFullName(defaults?.fullName ?? '')
      setPhone(defaults?.phone ?? '')
      setTelegramUsername(defaults?.telegramUsername ?? '')
      setTelegramId(defaults?.telegramId ?? '')
      setCity(defaults?.city ?? '')
      setAddress('')
      setVacancy('')
      setCuratorId(null)
      setTransferredAt(null)
    }
  }, [conversationId, defaults])

  // Reset when the conversation changes — state adjustment during render
  // (the React-recommended alternative to a setState-in-effect). EVERY field
  // is reset here: previously only cardId was cleared, which leaked
  // the previous lead's data into the next dialog until a page reload.
  const [prevConversationId, setPrevConversationId] = useState(conversationId)
  if (prevConversationId !== conversationId) {
    setPrevConversationId(conversationId)
    setOpen(false)
    setCardId(null)
    setFreeComment('')
    setFullName(defaults?.fullName ?? '')
    setPhone(defaults?.phone ?? '')
    setTelegramUsername(defaults?.telegramUsername ?? '')
    setTelegramId(defaults?.telegramId ?? '')
    setCity(defaults?.city ?? '')
    setAddress('')
    setVacancy('')
    setCuratorId(null)
    setTransferredAt(null)
  }

  function toggleOpen() {
    const next = !open
    setOpen(next)
    // Refetch on every open: the card may have been updated from another
    // dialog of the same contact or by the curator/admin meanwhile.
    if (next) void load()
  }

  // Esc closes the card first (capture phase + preventDefault so the
  // inbox-level handler doesn't ALSO close the dialog in the same press);
  // a second Esc then closes the dialog as usual.
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      setOpen(false)
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  // Curator search by city (SWR keyed by the trimmed query).
  const cityQuery = open ? city.trim() : ''
  const { data: curatorsData, isLoading: searching } = useSWR(
    cityQuery.length >= 2 ? ['curator-city-search', cityQuery] : null,
    () => findCuratorsByCityAction(cityQuery),
    { revalidateOnFocus: false, keepPreviousData: true, dedupingInterval: 300 },
  )
  const curators: CuratorWithLoad[] =
    cityQuery.length >= 2 ? (curatorsData ?? []) : []

  // Детали карточки (статусы/комментарии менеджера по кадрам + вложения) — после сохранения.
  const { data: detail, mutate: mutateDetail } = useSWR(
    open && cardId ? ['lead-card-detail', cardId] : null,
    () => getLeadCardDetailAction(cardId as string),
    { revalidateOnFocus: false },
  )

  function submitComment() {
    if (!cardId || !freeComment.trim()) return
    startTransition(async () => {
      const res = await addLeadCommentAction({
        leadCardId: cardId,
        body: freeComment,
      })
      if (res.ok) {
        toast.success(res.message)
        setFreeComment('')
        await mutateDetail()
      } else {
        toast.error(res.message)
      }
    })
  }

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
        telegramId,
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
        // Подхватить id только что созданной карточки — открывает блок
        // файлов/комментариев без повторного открытия панели.
        if (!cardId) await load()
      } else {
        toast.error(res.message)
      }
    })
  }

  /**
   * Вложения доступны СРАЗУ, до сохранения: при первом прикреплении карточка
   * тихо сохраняется с текущими полями, и файл цепляется уже к ней.
   */
  const ensureCardId = useCallback(async (): Promise<string | null> => {
    if (cardId) return cardId
    const res = await saveLeadCardAction({
      conversationId,
      fullName,
      phone,
      telegramUsername,
      telegramId,
      city,
      address,
      vacancy,
      curatorId: null,
    })
    if (!res.ok) {
      toast.error(res.message)
      return null
    }
    const card = await getLeadCardAction(conversationId)
    if (card) setCardId(card.id)
    return card?.id ?? null
  }, [
    cardId,
    conversationId,
    fullName,
    phone,
    telegramUsername,
    telegramId,
    city,
    address,
    vacancy,
  ])

  // Прикрепление кружка/фото происходит в баре навигации по треду (вне этой
  // панели) — событие сообщает карточке, что список вложений изменился.
  useEffect(() => {
    if (!cardId) return
    const onChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ leadCardId?: string }>).detail
      if (!detail?.leadCardId || detail.leadCardId === cardId)
        void mutateDetail()
    }
    window.addEventListener('omnidesk:lead-attachments-changed', onChanged)
    return () =>
      window.removeEventListener('omnidesk:lead-attachments-changed', onChanged)
  }, [cardId, mutateDetail])

  return (
    <>
      <Button
        variant={transferredAt ? 'default' : 'ghost'}
        size="sm"
        className="gap-1.5"
        title="Карточка лида"
        aria-label="Карточка лида"
        aria-expanded={open}
        onClick={toggleOpen}
      >
        <ClipboardList className="size-4" />
        <span className="hidden sm:inline">Карточка</span>
      </Button>

      {/* Mobile-only dim backdrop with a smooth fade (desktop keeps the
          dialog fully visible and clickable next to the docked panel). */}
      <button
        type="button"
        className={cn(
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-200 supports-backdrop-filter:backdrop-blur-[2px] sm:hidden',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-label="Закрыть карточку"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={() => setOpen(false)}
      />

      {/* Always-mounted panel sliding in/out with the same smooth
          transition-transform the «О контакте» drawer uses. Docked to the
          right edge on desktop so the dialog stays readable beside it. */}
      <aside
        role="dialog"
        aria-label="Карточка лида"
        aria-hidden={!open}
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10',
          'transition-transform duration-300 ease-out',
          // Mobile: bottom sheet sliding up.
          'max-sm:inset-x-0 max-sm:bottom-0 max-sm:h-[min(92dvh,100dvh)] max-sm:rounded-t-2xl',
          open ? 'max-sm:translate-y-0' : 'max-sm:translate-y-full',
          // Desktop: right-docked column sliding in.
          'sm:inset-y-0 sm:right-0 sm:w-[min(28rem,100vw)] sm:max-w-[28rem] sm:border-l sm:border-border',
          open ? 'sm:translate-x-0' : 'sm:translate-x-full',
          !open && 'pointer-events-none',
        )}
      >
            <header className="flex shrink-0 items-start justify-between gap-3 border-b border-border px-4 py-3.5 sm:px-5">
              <div className="min-w-0">
                <p className="text-base font-semibold tracking-tight">
                  Карточка лида
                </p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Данные для передачи менеджеру по кадрам
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
              <Field label="Telegram ID">
                <Input
                  value={telegramId}
                  onChange={(e) => setTelegramId(e.target.value)}
                  placeholder="123456789"
                  inputMode="numeric"
                />
              </Field>
              <Field label="Город" required>
                <CityInput
                  value={city}
                  onValueChange={(v) => {
                    setCity(v)
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
                    Менеджеры по кадрам по городу
                  </span>
                  {searching ? (
                    <p className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" />
                      Ищем…
                    </p>
                  ) : curators.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                      Нет менеджеров по кадрам для «{city.trim()}»
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
                            <span className="flex min-w-0 items-center gap-1">
                              <MapPin className="size-3 shrink-0" />
                              <span className="truncate">
                                {c.cities?.length
                                  ? c.cities.join(', ')
                                  : c.city}
                              </span>
                            </span>
                            <span
                              className="rounded bg-muted px-1.5 py-0.5 text-[10px]"
                              title="Активных лидов у менеджера по кадрам"
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

              {/* Файлы: доступны СРАЗУ (карточка сохранится тихо при первом
                  прикреплении). Кружки/фото выбираются навигацией по треду. */}
              <div className="border-t border-border pt-3.5">
                <LeadAttachments
                  leadCardId={cardId}
                  ensureCardId={ensureCardId}
                  conversationId={conversationId}
                  attachments={detail?.attachments ?? []}
                  onChanged={() => void mutateDetail()}
                  onBrowseMedia={
                    onBrowseMedia
                      ? async (kind) => {
                          const id = await ensureCardId()
                          if (id) onBrowseMedia(kind, id)
                        }
                      : undefined
                  }
                />
              </div>

              {cardId ? (
                <>
                  {/* Статус менеджера по кадрам — менеджер видит текущий статус и историю */}
                  {detail?.card?.status || detail?.statusHistory?.length ? (
                    <div className="flex flex-col gap-2 border-t border-border pt-3.5">
                      <p className="text-sm font-semibold">Статус у менеджера по кадрам</p>
                      {detail?.card ? (
                        <LeadStatusBadge
                          status={detail.card.status}
                          previousStatus={detail.card.previousStatus}
                        />
                      ) : null}
                      {detail?.statusHistory?.length ? (
                        <ul className="flex flex-col gap-1">
                          {detail.statusHistory.slice(0, 5).map((h) => (
                            <li
                              key={h.id}
                              className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground"
                            >
                              <span>{formatPanelDateTime(h.createdAt)}</span>
                              <LeadHistoryEvent entry={h} />
                              {h.curatorName ? <span>— {h.curatorName}</span> : null}
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Комментарии: менеджер пишет свои и видит комментарии менеджера по кадрам */}
                  <div className="flex flex-col gap-2 border-t border-border pt-3.5">
                    <p className="text-sm font-semibold">Комментарии</p>
                    <Textarea
                      value={freeComment}
                      onChange={(e) => setFreeComment(e.target.value)}
                      placeholder="Комментарий по лиду (виден менеджеру по кадрам и админу)…"
                      rows={2}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="self-start"
                      disabled={pending || !freeComment.trim()}
                      onClick={submitComment}
                    >
                      Добавить комментарий
                    </Button>
                    {(detail?.comments ?? []).length === 0 ? (
                      <p className="text-xs text-muted-foreground">Пока пусто</p>
                    ) : (
                      <ul className="flex flex-col gap-2">
                        {(detail?.comments ?? []).map((c) => (
                          <li
                            key={c.id}
                            className="rounded-lg border border-border bg-muted/30 px-3 py-2.5"
                          >
                            <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                              <span className="font-medium text-foreground">
                                {c.authorName ?? '—'}
                              </span>
                              {c.status ? (
                                <Badge
                                  variant="outline"
                                  className="border-transparent bg-background text-[10px]"
                                >
                                  {leadStatusLabel(c.status)}
                                </Badge>
                              ) : null}
                              <span className="ml-auto">
                                {formatPanelDateTime(c.createdAt)}
                              </span>
                            </div>
                            <p className="whitespace-pre-wrap text-sm leading-relaxed">
                              {c.body}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </>
              ) : (
                <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
                  Комментарии станут доступны после сохранения карточки.
                  Файлы, кружки и фото можно прикреплять сразу — карточка
                  сохранится автоматически.
                </p>
              )}
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
    </>
  )
}

function formatPanelDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
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
