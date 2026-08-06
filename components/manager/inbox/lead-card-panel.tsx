'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'
import { ClipboardList, Loader2, MapPin, Send } from 'lucide-react'
import { toast } from 'sonner'
import {
  findCuratorsByCityAction,
  getLeadCardAction,
  saveLeadCardAction,
} from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { Manager } from '@/lib/types'

/**
 * «Карточка лида» — кнопка рядом с ИИ. Открывает панель рядом (popover),
 * не поверх всего экрана. Менеджер заполняет данные и передаёт куратору
 * по совпадению города.
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
  const [curators, setCurators] = useState<Manager[]>([])
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
    if (open && !loaded) {
      void load()
    }
  }, [open, loaded, load])

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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant={transferredAt ? 'default' : 'ghost'}
            size="sm"
            className="gap-1.5"
            title="Карточка лида"
            aria-label="Карточка лида"
          >
            <ClipboardList className="size-4" />
            <span className="hidden sm:inline">Карточка</span>
          </Button>
        }
      />
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[min(100vw-2rem,22rem)] p-0"
      >
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold">Карточка лида</p>
            <p className="text-xs text-muted-foreground">
              Данные для передачи куратору
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(false)}
            aria-label="Закрыть"
          >
            ×
          </Button>
        </div>

        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto p-4">
          <Field label="ФИО" required>
            <Input
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              placeholder="Иван Иванов"
            />
          </Field>
          <Field label="Телефон">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+7…"
            />
          </Field>
          <Field label="Telegram username">
            <Input
              value={telegramUsername}
              onChange={(e) => setTelegramUsername(e.target.value)}
              placeholder="@username"
            />
          </Field>
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
                <p className="text-xs text-muted-foreground">
                  Нет кураторов для «{city.trim()}»
                </p>
              ) : (
                <div className="flex flex-col gap-1">
                  {curators.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => setCuratorId(c.id)}
                      className={cn(
                        'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                        curatorId === c.id
                          ? 'border-primary bg-primary/10'
                          : 'border-border hover:bg-muted',
                      )}
                    >
                      <span className="font-medium">{c.name}</span>
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <MapPin className="size-3" />
                        {c.city}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : null}

          {transferredAt ? (
            <p className="rounded-md bg-success/10 px-3 py-2 text-xs text-success">
              Передано{' '}
              {new Date(transferredAt).toLocaleString('ru-RU', {
                dateStyle: 'short',
                timeStyle: 'short',
              })}
            </p>
          ) : null}
        </div>

        <div className="flex gap-2 border-t border-border p-3">
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
            className="flex-1"
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
        </div>
      </PopoverContent>
    </Popover>
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
