'use client'

/**
 * Живой бейдж непрочитанного на пункте сайдбара. Держит собственный счётчик,
 * стартуя с серверного значения (без мигания при загрузке), и перезапрашивает
 * его через переданный scoped-экшен на каждый push-сигнал `inbox` (кадр
 * `update` общего EventSource), на реконнект и при смене маршрута (открыл
 * раздел → диалоги пометились прочитанными → счётчик упал).
 *
 * Дебаунс схлопывает пачку событий (пришёл альбом из 10 сообщений) в один
 * запрос. Экшен дешёвый (count(*)), поэтому это не нагружает БД.
 */
import { useEffect, useRef, useState } from 'react'
import { usePathname } from 'next/navigation'
import {
  onStreamInbox,
  onStreamReconnect,
} from '@/lib/hooks/realtime-stream'
import { cn } from '@/lib/utils'

export function NavUnreadBadge({
  initial,
  fetchCount,
  collapsed,
}: {
  initial: number
  fetchCount: () => Promise<number>
  /** В свёрнутом рэйле бейдж рисуется точкой поверх иконки, а не числом. */
  collapsed?: boolean
}) {
  const [count, setCount] = useState(initial)
  const pathname = usePathname()

  // Свежий fetcher в ref: server action прокидывается новым референсом на
  // каждый рендер layout, но подписку пересоздавать из-за этого не нужно.
  const fetchRef = useRef(fetchCount)
  useEffect(() => {
    fetchRef.current = fetchCount
  })

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let alive = true
    const refresh = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(async () => {
        try {
          const n = await fetchRef.current()
          if (alive) setCount(n)
        } catch {
          /* сеть/сессия моргнула — оставляем прежнее значение */
        }
      }, 400)
    }

    const offInbox = onStreamInbox(refresh)
    const offReconnect = onStreamReconnect(refresh)
    // Смена маршрута: заход в раздел обнуляет непрочитанное на сервере —
    // перечитываем, чтобы бейдж погас сразу, не дожидаясь события.
    refresh()

    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      offInbox()
      offReconnect()
    }
    // pathname в зависимостях — рефетч при каждом переходе.
  }, [pathname])

  if (count <= 0) return null

  if (collapsed) {
    // Свёрнутый рэйл: место есть только под точку-индикатор поверх иконки.
    return (
      <span
        aria-label={`Непрочитанные: ${count}`}
        className="absolute right-1 top-1 size-2 rounded-full bg-primary ring-2 ring-sidebar"
      />
    )
  }

  return (
    <span
      aria-label={`Непрочитанные: ${count}`}
      className={cn(
        'ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold leading-5 text-primary-foreground tabular-nums',
      )}
    >
      {count > 99 ? '99+' : count}
    </span>
  )
}
