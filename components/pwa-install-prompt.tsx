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
 * Логика платформы/окна установки — в useInstallPrompt(); здесь только UI.
 * Ненавязчиво: нижняя карточка появляется один раз, закрывается и не мозолит
 * глаза (повтор не раньше, чем через REMIND_AFTER_DAYS).
 */

import { useEffect, useState } from 'react'
import {
  Download,
  Share,
  SquarePlus,
  X,
  Compass,
  MonitorDown,
  Check,
} from 'lucide-react'
import {
  useInstallPrompt,
  type InstallPlatform,
} from '@/lib/use-install-prompt'

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

interface Step {
  icon: React.ReactNode
  text: React.ReactNode
}

/** Заголовок и шаги под конкретную платформу. */
function instructionsFor(platform: InstallPlatform): {
  title: string
  intro: string
  steps: Step[]
} {
  const shareIcon = <Share className="size-4" />
  const addIcon = <SquarePlus className="size-4" />
  const safariIcon = <Compass className="size-4" />
  const installIcon = <MonitorDown className="size-4" />

  switch (platform) {
    case 'ios-safari':
      return {
        title: 'Установка на iPhone или iPad',
        intro: 'Три шага в Safari — и приложение появится на экране «Домой».',
        steps: [
          {
            icon: shareIcon,
            text: (
              <>
                Нажмите кнопку <b>«Поделиться»</b> в панели Safari
              </>
            ),
          },
          {
            icon: addIcon,
            text: (
              <>
                Выберите <b>«На экран „Домой“»</b>
              </>
            ),
          },
          {
            icon: <Check className="size-4" />,
            text: (
              <>
                Нажмите <b>«Добавить»</b> — готово
              </>
            ),
          },
        ],
      }
    case 'ios-other':
      return {
        title: 'Откройте сайт в Safari',
        intro:
          'В этом браузере на iOS установка недоступна. Откройте сайт в Safari — там появится возможность добавить приложение на экран «Домой».',
        steps: [
          {
            icon: safariIcon,
            text: <>Скопируйте адрес и откройте его в Safari</>,
          },
          {
            icon: shareIcon,
            text: (
              <>
                В Safari нажмите <b>«Поделиться»</b>
              </>
            ),
          },
          {
            icon: addIcon,
            text: (
              <>
                Выберите <b>«На экран „Домой“»</b>
              </>
            ),
          },
        ],
      }
    case 'macos-safari':
      return {
        title: 'Добавить в Dock',
        intro: 'В Safari на macOS приложение можно закрепить в Dock.',
        steps: [
          {
            icon: shareIcon,
            text: (
              <>
                Откройте меню <b>«Файл»</b> в строке меню Safari
              </>
            ),
          },
          {
            icon: addIcon,
            text: (
              <>
                Выберите <b>«Добавить в Dock…»</b>
              </>
            ),
          },
          {
            icon: <Check className="size-4" />,
            text: <>Приложение появится в Dock как отдельное окно</>,
          },
        ],
      }
    case 'desktop':
      return {
        title: 'Установка на компьютер',
        intro:
          'В Chrome или Edge приложение ставится прямо из адресной строки.',
        steps: [
          {
            icon: installIcon,
            text: (
              <>
                Нажмите значок <b>установки</b> справа в адресной строке
              </>
            ),
          },
          {
            icon: <Check className="size-4" />,
            text: (
              <>
                Подтвердите <b>«Установить»</b> — откроется отдельное окно
              </>
            ),
          },
        ],
      }
    default:
      return {
        title: 'Установка приложения',
        intro:
          'Откройте сайт в Chrome, Edge или Safari, чтобы установить приложение на устройство.',
        steps: [],
      }
  }
}

function InstallInstructionsDialog({
  open,
  platform,
  onClose,
}: {
  open: boolean
  platform: InstallPlatform
  onClose: () => void
}) {
  if (!open) return null
  const { title, intro, steps } = instructionsFor(platform)

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="pwa-install-title"
      className="fixed inset-0 z-[10001] flex items-center justify-center bg-background/80 backdrop-blur-sm"
      style={{
        padding:
          'max(1.5rem, env(safe-area-inset-top)) 1.5rem max(1.5rem, env(safe-area-inset-bottom))',
      }}
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-sm flex-col overflow-hidden rounded-3xl border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-col items-center gap-4 px-6 pt-8 pb-5 text-center">
          <span className="flex size-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Download className="size-8" strokeWidth={1.75} />
          </span>
          <div className="space-y-2">
            <h2
              id="pwa-install-title"
              className="text-lg font-semibold text-balance text-foreground"
            >
              {title}
            </h2>
            <p className="text-sm leading-relaxed text-pretty text-muted-foreground">
              {intro}
            </p>
          </div>
        </div>

        {steps.length > 0 ? (
          <ol className="mx-6 mb-6 flex flex-col gap-2 rounded-2xl bg-muted/50 p-4 text-left">
            {steps.map((step, i) => (
              <li key={i} className="flex items-center gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background text-foreground">
                  {step.icon}
                </span>
                <p className="text-sm text-foreground">{step.text}</p>
              </li>
            ))}
          </ol>
        ) : null}

        <button
          type="button"
          onClick={onClose}
          className="mx-6 mb-6 inline-flex h-12 items-center justify-center rounded-2xl bg-primary text-base font-semibold text-primary-foreground transition-colors hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        >
          Понятно
        </button>
      </div>
    </div>
  )
}
