'use client'

import { useRef, useState, type ReactNode } from 'react'
import { Reply } from 'lucide-react'
import { cn } from '@/lib/utils'

/** Horizontal drag past this many px triggers a reply on release. */
const SWIPE_REPLY_THRESHOLD = 56

/**
 * Свайп-влево по сообщению → быстрый ответ (как в Telegram/WhatsApp).
 *
 * ОДИН слой: обёртка сама `w-full flex justify-*` (чтобы `max-w-[80%]` бабла
 * считался именно от неё — от полной ширины ряда, а не от промежуточного бокса;
 * это и был баг со съехавшими бабблами и полосой у края) И одновременно несёт
 * саму трансформацию сдвига и touch-обработчики. Отдельного вложенного
 * translateX-слоя больше нет.
 *
 * Только touch и только по горизонтали: пока жест вертикальный, лента
 * скроллится обычным образом (touch-action: pan-y). Величину сдвига дублируем в
 * ref, чтобы onTouchEnd видел актуальное значение без устаревшего замыкания —
 * поэтому свайп срабатывает КАЖДЫЙ раз, а не «один раз и всё».
 */
export function SwipeToReply({
  enabled,
  align,
  onReply,
  children,
}: {
  enabled: boolean
  /** Сторона выравнивания баббла в ряду (out → вправо, in → влево). */
  align: 'start' | 'end'
  onReply: () => void
  children: ReactNode
}) {
  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)
  const start = useRef<{ x: number; y: number; active: boolean } | null>(null)

  const set = (v: number) => {
    dxRef.current = v
    setDx(v)
  }
  const reset = () => {
    start.current = null
    set(0)
  }

  if (!enabled) return <>{children}</>

  return (
    <div
      className={cn(
        'relative flex w-full',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
      style={{
        transform: dx ? `translateX(${dx}px)` : undefined,
        transition: dx === 0 ? 'transform 0.18s ease-out' : 'none',
        touchAction: 'pan-y',
      }}
      onTouchStart={(e) => {
        const t = e.touches[0]
        start.current = { x: t.clientX, y: t.clientY, active: false }
      }}
      onTouchMove={(e) => {
        const s = start.current
        if (!s) return
        const t = e.touches[0]
        const dX = t.clientX - s.x
        const dY = t.clientY - s.y
        // Направление решаем один раз. Свайп — в ЛЮБУЮ сторону (в Telegram для
        // ответа тянут вправо), поэтому раньше свайп вправо «не работал» —
        // обрезался в 0. Теперь ведём баббл по знаку жеста в обе стороны.
        if (!s.active) {
          if (Math.abs(dX) > 8 && Math.abs(dX) > Math.abs(dY) * 1.2) {
            s.active = true
          } else if (Math.abs(dY) > 8) {
            start.current = null
            return
          } else {
            return
          }
        }
        set(Math.max(Math.min(dX, 88), -88))
      }}
      onTouchEnd={() => {
        if (
          start.current?.active &&
          Math.abs(dxRef.current) >= SWIPE_REPLY_THRESHOLD
        ) {
          onReply()
        }
        reset()
      }}
      onTouchCancel={reset}
    >
      {/* Иконка ответа проявляется по мере сдвига на трейлинг-краю (со стороны,
          противоположной движению пальца). pointer-events-none — не мешает
          тапам и не вылезает за обёртку. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 flex items-center',
          dx > 0 ? 'left-1' : 'right-1',
        )}
        style={{ opacity: Math.min(1, Math.abs(dx) / SWIPE_REPLY_THRESHOLD) }}
        aria-hidden
      >
        <span className="rounded-full bg-primary/15 p-1.5 text-primary">
          <Reply className="size-4" />
        </span>
      </div>
      {children}
    </div>
  )
}
