'use client'

/**
 * Разовое объявление для пользователей МОБИЛЬНОГО PWA: «проект обновлён, ваша
 * установленная версия может быть неактуальной — удалите и поставьте заново».
 *
 * Чем отличается от UpdateWatcher: тот АВТОМАТИЧЕСКИ перезагружает вкладку на
 * каждый деплой. А это — РУЧНОЙ, управляемый нами анонс на случай, когда одной
 * перезагрузки мало (например, сменились иконки/manifest/service worker и iOS
 * держит старый закэшированный шелл). Показывается один раз и только тем, кто
 * открыл приложение как установленное PWA (standalone), закрывается одним
 * нажатием и больше не появляется — пока мы не поднимем версию ниже.
 *
 * КАК ВЫПУСТИТЬ НОВЫЙ АНОНС: поднимите NOTICE_VERSION (любая новая строка).
 * Все PWA-пользователи увидят окно ровно один раз после установки этой версии;
 * кто уже подтвердил предыдущую — увидят снова, потому что ключ подтверждения
 * привязан к версии. Пустая строка = анонс выключен.
 */

import { useEffect, useState } from 'react'
import { RefreshCw, Trash2, Download } from 'lucide-react'

/**
 * Версия текущего анонса. Поднимите её (напр. 'v2', '2025-01'), когда нужно
 * снова показать окно всем PWA-пользователям после очередного крупного
 * обновления. Установите '' чтобы полностью скрыть анонс.
 */
const NOTICE_VERSION = '2026-01-reinstall'

/** localStorage-ключ с версией уже подтверждённого пользователем анонса. */
const ACK_KEY = 'od:pwa-reinstall-ack'

/** Открыто ли приложение как установленное PWA (а не вкладка браузера)? */
function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false
  // iOS Safari: нестандартный navigator.standalone. Остальные: display-mode.
  const iosStandalone =
    'standalone' in window.navigator &&
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  const displayModeStandalone =
    typeof window.matchMedia === 'function' &&
    (window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.matchMedia('(display-mode: minimal-ui)').matches)
  return Boolean(iosStandalone || displayModeStandalone)
}

export function PwaReinstallNotice() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!NOTICE_VERSION) return
    if (!isStandalonePwa()) return
    let acked: string | null = null
    try {
      acked = localStorage.getItem(ACK_KEY)
    } catch {
      // Приватный режим без localStorage — покажем окно (в худшем случае ещё
      // раз при следующем запуске, что не критично для разового анонса).
    }
    if (acked !== NOTICE_VERSION) setOpen(true)
  }, [])

  if (!open) return null

  const dismiss = () => {
    try {
      localStorage.setItem(ACK_KEY, NOTICE_VERSION)
    } catch {
      /* best-effort — окно всё равно закроем */
    }
    setOpen(false)
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="pwa-reinstall-title"
      aria-describedby="pwa-reinstall-body"
      className="fixed inset-0 z-[10000] flex items-center justify-center bg-background/80 backdrop-blur-sm"
      style={{
        padding: 'max(1.5rem, env(safe-area-inset-top)) 1.5rem max(1.5rem, env(safe-area-inset-bottom))',
      }}
    >
      <div className="flex w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-2xl">
        <div className="flex flex-col items-center gap-4 px-6 pt-8 pb-6 text-center">
          <span className="relative flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <RefreshCw className="size-8" strokeWidth={1.75} />
          </span>
          <div className="space-y-2">
            <h2
              id="pwa-reinstall-title"
              className="text-lg font-semibold text-balance text-foreground"
            >
              Приложение обновлено
            </h2>
            <p
              id="pwa-reinstall-body"
              className="text-sm leading-relaxed text-pretty text-muted-foreground"
            >
              Вышло крупное обновление, и установленная версия может работать
              некорректно. Чтобы всё работало как надо, переустановите
              приложение.
            </p>
          </div>
        </div>

        {/* Два коротких шага — визуально, чтобы было понятно без раздумий. */}
        <div className="mx-6 mb-6 flex flex-col gap-2 rounded-2xl bg-muted/50 p-4 text-left">
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-foreground">
              <Trash2 className="size-4" />
            </span>
            <p className="text-sm text-foreground">
              Удалите иконку приложения с экрана «Домой»
            </p>
          </div>
          <div className="flex items-center gap-3">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-foreground">
              <Download className="size-4" />
            </span>
            <p className="text-sm text-foreground">
              Откройте сайт в браузере и установите заново
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={dismiss}
          className="mx-6 mb-6 inline-flex h-12 items-center justify-center rounded-2xl bg-primary text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          Понятно
        </button>
      </div>
    </div>
  )
}
