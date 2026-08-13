'use client'

import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * Единый шелл боковых панелей (карточка лида и т.п.) — механика «как у Apple»:
 *
 * - Панель ВСЕГДА смонтирована и ездит `transition-transform` (композитинг на
 *   GPU, ни одного кадра layout/paint) — тот же паттерн, что у docked-карточки
 *   в Inbox менеджера, которая открывается идеально плавно.
 * - Подложка затемняется только через `transition-opacity` — НИКАКОГО
 *   анимируемого backdrop-blur: пере-блюривание всей страницы каждый кадр
 *   и есть источник «глюков» при открытии.
 * - Контент монтируется лениво при первом открытии и дальше живёт: повторные
 *   открытия мгновенны, а страница со списком не таскает панель в DOM зря.
 *
 * Мобайл — bottom-sheet снизу, десктоп — правая колонка. Esc закрывает,
 * скролл body блокируется, пока панель открыта.
 */
const SLIDE_MS = 300

export function SlideOver({
  open,
  onClose,
  title,
  children,
  widthClass = 'sm:w-[min(32rem,100vw)]',
}: {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  widthClass?: string
}) {
  // Ленивый mount: до первого открытия контент не существует в DOM.
  const [everOpened, setEverOpened] = useState(open)
  if (open && !everOpened) setEverOpened(true)

  // Первое открытие: пока панель едет (300мс), внутри лёгкий скелетон —
  // тяжёлый mount контента (формы, редакторы, история) происходит ПОСЛЕ
  // завершения transition и не съедает кадры анимации. Дальше контент
  // живёт в DOM, и повторные открытия мгновенны и полностью плавны.
  const [contentReady, setContentReady] = useState(open)
  useEffect(() => {
    if (!everOpened || contentReady) return
    const t = setTimeout(() => setContentReady(true), SLIDE_MS + 20)
    return () => clearTimeout(t)
  }, [everOpened, contentReady])

  // Esc закрывает панель (только пока открыта).
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      e.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, onClose])

  // Блокировка скролла страницы под открытой панелью.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  // Фокус на панель при открытии — клавиатура и скринридеры попадают внутрь.
  const asideRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (open) asideRef.current?.focus()
  }, [open])

  return (
    <>
      <button
        type="button"
        className={cn(
          'fixed inset-0 z-40 bg-black/40 transition-opacity duration-300',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
        aria-label="Закрыть"
        aria-hidden={!open}
        tabIndex={open ? 0 : -1}
        onClick={onClose}
      />
      <aside
        ref={asideRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        aria-hidden={!open}
        tabIndex={-1}
        className={cn(
          'fixed z-50 flex flex-col bg-popover text-popover-foreground shadow-2xl ring-1 ring-foreground/10 outline-none',
          'transition-transform duration-300 ease-out will-change-transform',
          // Мобайл: bottom-sheet, выезжает снизу.
          'max-sm:inset-x-0 max-sm:bottom-0 max-sm:h-[min(94dvh,100dvh)] max-sm:rounded-t-2xl',
          open ? 'max-sm:translate-y-0' : 'max-sm:translate-y-full',
          // Десктоп: правая колонка, выезжает справа.
          'sm:inset-y-0 sm:right-0 sm:border-l sm:border-border',
          widthClass,
          open ? 'sm:translate-x-0' : 'sm:translate-x-full',
          !open && 'pointer-events-none',
        )}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3 sm:px-5">
          <p className="text-sm font-semibold">{title}</p>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </Button>
        </header>
        {everOpened && contentReady ? (
          children
        ) : everOpened ? (
          <div className="flex flex-1 flex-col gap-5 px-4 py-4 sm:px-5">
            <SlideOverSectionSkeleton rows={3} />
            <SlideOverSectionSkeleton rows={2} />
            <SlideOverSectionSkeleton rows={2} />
          </div>
        ) : null}
      </aside>
    </>
  )
}

/** Лёгкий скелетон секции: данные из сети догружаются, каркас уже виден. */
export function SlideOverSectionSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="flex animate-pulse flex-col gap-2" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          className="h-3.5 rounded bg-muted"
          style={{ width: `${85 - i * 20}%` }}
        />
      ))}
    </div>
  )
}
