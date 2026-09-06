'use client'

/**
 * Приглашение установить приложение + пошаговая инструкция под конкретную
 * платформу. Закрывает главный пробел «просто PWA»: у пользователя не было
 * понятного способа установиться.
 *
 *  - Android / десктопный Chrome/Edge → установка в ОДИН тап через нативное
 *    окно (перехваченное `beforeinstallprompt`).
 *  - iOS Safari → анимированная инструкция Поделиться → На экран «Домой».
 *  - iOS в чужом браузере → подсказка открыть сайт в Safari.
 *  - macOS Safari → Файл → «Добавить в Dock».
 *  - Десктопный Chromium без готового события → значок установки в адресной
 *    строке.
 *
 * Логика платформы/окна установки — в useInstallPrompt(); пошаговая инструкция
 * (модалка) — в pwa-install-dialog (общая с карточкой в настройках). Здесь
 * только нижнее приглашение: появляется один раз, закрывается и не мозолит
 * глаза (повтор не раньше, чем через REMIND_AFTER_DAYS).
 */

import { useEffect, useState } from 'react'
import { Download, X } from 'lucide-react'
import { useInstallPrompt } from '@/lib/use-install-prompt'
import { InstallInstructionsDialog } from '@/components/pwa-install-dialog'

/** localStorage-ключ с меткой времени последнего закрытия приглашения. */
const DISMISS_KEY = 'od:pwa-install-dismissed-at'
/** Через сколько дней после закрытия можно предложить снова. */
const REMIND_AFTER_DAYS = 14
/** Пауза перед показом, чтобы не пугать пользователя на первом кадре. */
const SHOW_DELAY_MS = 2500

function dismissedRecently(): boolean {
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    if (!raw) return false
    const at = Number(raw)
    if (!Number.isFinite(at)) return false
    return Date.now() - at < REMIND_AFTER_DAYS * 24 * 60 * 60 * 1000
  } catch {
    return false
  }
}

function rememberDismissed() {
  try {
    localStorage.setItem(DISMISS_KEY, String(Date.now()))
  } catch {
    /* приватный режим без localStorage — не критично */
  }
}

export function PwaInstallPrompt() {
  const { platform, canPromptNative, installable, promptInstall } =
    useInstallPrompt()
  const [bannerOpen, setBannerOpen] = useState(false)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Показ приглашения с задержкой, если можно установить и его недавно не
  // закрывали. Standalone/неподдерживаемые платформы отсекает `installable`.
  useEffect(() => {
    if (!installable) return
    if (dismissedRecently()) return
    const t = setTimeout(() => setBannerOpen(true), SHOW_DELAY_MS)
    return () => clearTimeout(t)
  }, [installable])

  if (!installable) return null

  const closeBanner = () => {
    rememberDismissed()
    setBannerOpen(false)
  }

  const handleInstall = async () => {
    // Один тап там, где есть нативное окно; иначе — инструкция для платформы.
    if (canPromptNative) {
      setBusy(true)
      try {
        const accepted = await promptInstall()
        if (accepted) {
          setBannerOpen(false)
          return
        }
      } finally {
        setBusy(false)
      }
      // Отказались — закроем баннер и не будем донимать.
      closeBanner()
      return
    }
    setDialogOpen(true)
  }

  return (
    <>
      {bannerOpen ? (
        <div
          className="fixed inset-x-0 bottom-0 z-[9998] flex justify-center px-4"
          style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
        >
          <div className="flex w-full max-w-md items-center gap-3 rounded-2xl border border-border bg-card p-3 shadow-2xl animate-in slide-in-from-bottom-4 fade-in-0 duration-300">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
              <Download className="size-5" strokeWidth={1.75} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                Установить приложение
              </p>
              <p className="truncate text-xs text-muted-foreground">
                Быстрый доступ и уведомления прямо с экрана «Домой»
              </p>
            </div>
            <button
              type="button"
              onClick={() => void handleInstall()}
              disabled={busy}
              className="inline-flex h-9 shrink-0 items-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            >
              {canPromptNative ? 'Установить' : 'Как?'}
            </button>
            <button
              type="button"
              onClick={closeBanner}
              aria-label="Скрыть"
              className="shrink-0 rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      ) : null}

      <InstallInstructionsDialog
        open={dialogOpen}
        platform={platform}
        onClose={() => {
          setDialogOpen(false)
          closeBanner()
        }}
      />
    </>
  )
}
