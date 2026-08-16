'use client'

/**
 * Город с автодополнением из справочника (кастомный список, не datalist).
 * Подсказки — города и целые регионы («Чечня» → «Чеченская Республика»,
 * помечается как «весь регион»), из searchCityAction (миграция 124).
 */
import { useEffect, useRef, useState } from 'react'
import { Landmark, MapPin } from 'lucide-react'
import useSWR from 'swr'
import { searchCityAction } from '@/app/actions/lead-cards'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

export interface CitySuggestion {
  city: string
  region: string | null
  isRegion?: boolean
}

export function CityInput({
  id,
  name,
  defaultValue,
  value,
  onValueChange,
  placeholder = 'Москва',
  required,
  className,
}: {
  id?: string
  name?: string
  defaultValue?: string
  value?: string
  onValueChange?: (v: string) => void
  placeholder?: string
  required?: boolean
  className?: string
}) {
  // Для uncontrolled-режима значение живёт здесь же.
  const [inner, setInner] = useState(defaultValue ?? '')
  const current = value ?? inner
  const [open, setOpen] = useState(false)
  const [highlighted, setHighlighted] = useState(-1)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const q = current.trim()
  const { data: options } = useSWR(
    open && q.length > 0 ? ['city-search', q.toLowerCase()] : null,
    () => searchCityAction(q),
    { keepPreviousData: true, revalidateOnFocus: false },
  )
  const list: CitySuggestion[] = open && q.length > 0 ? (options ?? []) : []

  // Клик вне поля закрывает список.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [open])

  function setValue(v: string) {
    if (value === undefined) setInner(v)
    onValueChange?.(v)
  }

  function pick(s: CitySuggestion) {
    setValue(s.city)
    setOpen(false)
    setHighlighted(-1)
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      {name ? <input type="hidden" name={name} value={current} /> : null}
      <Input
        id={id}
        type="text"
        autoComplete="off"
        role="combobox"
        aria-expanded={open && list.length > 0}
        aria-autocomplete="list"
        placeholder={placeholder}
        required={required}
        value={current}
        onChange={(e) => {
          setValue(e.target.value)
          setOpen(true)
          setHighlighted(-1)
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!open || list.length === 0) return
          if (e.key === 'ArrowDown') {
            e.preventDefault()
            setHighlighted((h) => (h + 1) % list.length)
          } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            setHighlighted((h) => (h <= 0 ? list.length - 1 : h - 1))
          } else if (
            e.key === 'Enter' &&
            !e.nativeEvent.isComposing &&
            e.keyCode !== 229
          ) {
            if (highlighted >= 0 && list[highlighted]) {
              e.preventDefault()
              pick(list[highlighted])
            }
          } else if (e.key === 'Escape') {
            setOpen(false)
          }
        }}
      />
      {open && list.length > 0 ? (
        <ul
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1 max-h-56 overflow-y-auto rounded-xl bg-popover p-1 text-popover-foreground shadow-lg ring-1 ring-foreground/10 animate-in fade-in-0 zoom-in-95 duration-150"
        >
          {list.map((s, i) => (
            <li key={`${s.city}-${s.region}-${s.isRegion ? 'r' : 'c'}`}>
              <button
                type="button"
                role="option"
                aria-selected={i === highlighted}
                // pointerdown раньше blur — выбор срабатывает до закрытия.
                onPointerDown={(e) => {
                  e.preventDefault()
                  pick(s)
                }}
                onMouseEnter={() => setHighlighted(i)}
                className={cn(
                  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm transition-colors duration-75',
                  i === highlighted && 'bg-accent text-accent-foreground',
                )}
              >
                {s.isRegion ? (
                  <Landmark className="size-3.5 shrink-0 text-muted-foreground" />
                ) : (
                  <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{s.city}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {s.isRegion ? 'весь регион' : (s.region ?? '')}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
