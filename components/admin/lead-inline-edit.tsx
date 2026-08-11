'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { Check, Loader2, MapPin, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  adminSetLeadStatusAction,
  searchCityAction,
  softDeleteLeadAction,
  updateLeadFieldAction,
  updateLeadStatusAction,
} from '@/app/actions/lead-cards'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { LeadCard } from '@/lib/data/lead-cards'
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  LEAD_STATUS_TONE,
  STATUS_COMMENT_MIN_LEN,
  leadStatusLabel,
} from '@/lib/lead-status'
import { cn } from '@/lib/utils'

/* ------------------------- Статус + комментарий ------------------------- */

/**
 * Клик по статусу в строке → компактный Popover: выбрать статус, вписать
 * комментарий, сохранить. Без открытия полной карточки.
 *
 * variant='curator' сохраняет через updateLeadStatusAction (проверка
 * владельца + дисциплина на сервере); по умолчанию — админский action.
 * trigger позволяет отрисовать свой бейдж (например, LeadStatusBadge с
 * подсветкой «нужно обновить» у менеджера по кадрам).
 */
export function StatusInlineEditor({
  lead,
  onSaved,
  variant = 'admin',
  trigger,
}: {
  lead: LeadCard
  onSaved: () => void
  variant?: 'admin' | 'curator'
  trigger?: React.ReactElement
}) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<string>(lead.status ?? '')
  const [comment, setComment] = useState('')
  const [pending, startTransition] = useTransition()

  const tone = lead.status ? LEAD_STATUS_TONE[lead.status] : null

  function save() {
    if (!status) {
      toast.error('Выберите статус')
      return
    }
    startTransition(async () => {
      const action =
        variant === 'curator' ? updateLeadStatusAction : adminSetLeadStatusAction
      const res = await action({
        leadCardId: lead.id,
        status,
        comment,
      })
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setComment('')
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          trigger ?? (
            <button
              type="button"
              className="inline-flex cursor-pointer"
              aria-label="Изменить статус"
            >
              {tone && lead.status ? (
                <Badge
                  variant="outline"
                  className={cn(
                    'gap-1.5 border-transparent transition-opacity hover:opacity-75',
                    tone.bg,
                    tone.text,
                  )}
                >
                  <span className={cn('size-1.5 rounded-full', tone.dot)} />
                  {leadStatusLabel(lead.status)}
                </Badge>
              ) : (
                <Badge
                  variant="outline"
                  className="border-dashed text-muted-foreground transition-colors hover:text-foreground"
                >
                  Статус…
                </Badge>
              )}
            </button>
          )
        }
      />
      <PopoverContent align="start" side="bottom" className="w-72 p-3">
        <div className="flex flex-col gap-2.5">
          <p className="text-xs font-medium text-muted-foreground">
            Статус и комментарий
          </p>
          <div className="flex flex-wrap gap-1">
            {LEAD_STATUSES.map((s) => {
              const t = LEAD_STATUS_TONE[s]
              const active = status === s
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => setStatus(s)}
                  className={cn(
                    'rounded-full border px-2 py-0.5 text-xs transition-colors',
                    active
                      ? cn('border-transparent font-medium', t.bg, t.text)
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  {LEAD_STATUS_LABELS[s]}
                </button>
              )
            })}
          </div>
          <Textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder={`Комментарий (минимум ${STATUS_COMMENT_MIN_LEN} символов)…`}
            rows={2}
            className="min-h-16 text-sm"
          />
          <Button
            size="sm"
            disabled={pending || comment.trim().length < STATUS_COMMENT_MIN_LEN}
            onClick={save}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Сохранить
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* --------------------- Город с автодополнением региона --------------------- */

/**
 * Клик по городу → Popover с поиском по справочнику «город (регион)».
 * Выбор из списка или свободный ввод (город запомнится в справочнике).
 */
export function CityInlineEditor({
  lead,
  onSaved,
}: {
  lead: LeadCard
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(lead.city)
  const [options, setOptions] = useState<
    { city: string; region: string | null; isRegion?: boolean }[]
  >([])
  const [pending, startTransition] = useTransition()
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    if (debounce.current) clearTimeout(debounce.current)
    const q = value.trim()
    // Пустой запрос очищаем тоже асинхронно (setTimeout 0), чтобы не звать
    // setState синхронно внутри эффекта (react-hooks/set-state-in-effect).
    debounce.current = setTimeout(
      async () => {
        if (q.length < 1) {
          setOptions([])
          return
        }
        try {
          const res = await searchCityAction(q)
          setOptions(res)
        } catch {
          setOptions([])
        }
      },
      q.length < 1 ? 0 : 200,
    )
    return () => {
      if (debounce.current) clearTimeout(debounce.current)
    }
  }, [value, open])

  function save(city: string) {
    const v = city.trim()
    if (!v) {
      toast.error('Укажите город')
      return
    }
    startTransition(async () => {
      const res = await updateLeadFieldAction({
        leadCardId: lead.id,
        field: 'city',
        value: v,
      })
      if (res.ok) {
        toast.success('Город обновлён')
        setOpen(false)
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setValue(lead.city)
      }}
    >
      <PopoverTrigger
        render={
          <button type="button" className="inline-flex" aria-label="Изменить город">
            <Badge
              variant="outline"
              className="gap-1 border-transparent bg-muted text-muted-foreground transition-colors hover:text-foreground"
            >
              <MapPin className="size-3" />
              {lead.city || 'Город…'}
              {lead.region ? (
                <span className="text-[10px] opacity-70">({lead.region})</span>
              ) : null}
            </Badge>
          </button>
        }
      />
      <PopoverContent align="start" side="bottom" className="w-72 p-3">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">
            Город (регион подставится автоматически)
          </p>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                save(value)
              }
            }}
            placeholder="Начните вводить город…"
            className="h-8 text-sm"
            autoFocus
          />
          {options.length > 0 ? (
            <ul className="flex max-h-44 flex-col overflow-y-auto rounded-md border border-border">
              {options.map((o) => (
                <li key={`${o.city}-${o.region}-${o.isRegion ? 'r' : 'c'}`}>
                  <button
                    type="button"
                    onClick={() => save(o.city)}
                    className="flex w-full items-baseline justify-between gap-2 px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <span>{o.city}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {o.isRegion ? 'весь регион' : o.region}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !value.trim()}
            onClick={() => save(value)}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Сохранить как есть
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------ Текстовое поле по клику ------------------------ */

/** Клик по значению → маленький Popover с Input (ФИО, телефон, должность...). */
export function TextInlineEditor({
  lead,
  field,
  label,
  display,
  placeholder,
  className,
  onSaved,
}: {
  lead: LeadCard
  field: 'full_name' | 'phone' | 'telegram_username' | 'vacancy' | 'address'
  label: string
  display: string
  placeholder?: string
  className?: string
  onSaved: () => void
}) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(display)
  const [pending, startTransition] = useTransition()

  function save() {
    startTransition(async () => {
      const res = await updateLeadFieldAction({
        leadCardId: lead.id,
        field,
        value,
      })
      if (res.ok) {
        toast.success('Сохранено')
        setOpen(false)
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (o) setValue(display)
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            className={cn(
              'group inline-flex max-w-full items-center gap-1 text-left',
              className,
            )}
            aria-label={`Изменить: ${label}`}
          >
            <span className="truncate">{display || '—'}</span>
            <Pencil className="size-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-50" />
          </button>
        }
      />
      <PopoverContent align="start" side="bottom" className="w-64 p-3">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">{label}</p>
          <Input
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === 'Enter' &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                save()
              }
            }}
            placeholder={placeholder}
            className="h-8 text-sm"
            autoFocus
          />
          <Button size="sm" disabled={pending} onClick={save}>
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Check className="size-3.5" />
            )}
            Сохранить
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* --------------------- Удаление с причиной (в корзину) --------------------- */

/** Кнопка удаления: диалог с обязательной причиной → мягкое удаление. */
export function DeleteLeadButton({
  lead,
  onDeleted,
}: {
  lead: LeadCard
  onDeleted: () => void
}) {
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()

  function remove() {
    startTransition(async () => {
      const res = await softDeleteLeadAction({
        leadCardId: lead.id,
        reason,
      })
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setReason('')
        onDeleted()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="Удалить лид"
        className="text-muted-foreground hover:text-destructive"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-4" />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Удалить лид?</DialogTitle>
            <DialogDescription>
              {lead.fullName || 'Лид'} уйдёт в корзину и будет автоматически
              удалён навсегда через 30 дней. До этого его можно восстановить.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Причина удаления (обязательно)…"
            rows={2}
            className="min-h-16 text-sm"
          />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending || reason.trim().length < 3}
              onClick={remove}
            >
              {pending ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <Trash2 className="size-3.5" />
              )}
              В корзину
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
