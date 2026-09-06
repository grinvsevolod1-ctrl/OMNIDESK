'use client'

/**
 * Пошаговая инструкция установки под конкретную платформу. Вынесена отдельно,
 * чтобы её переиспользовали и нижнее приглашение (pwa-install-prompt), и
 * карточка «Установить приложение» в настройках (app-install-card).
 *
 * Логика определения платформы — в useInstallPrompt(); здесь только контент и
 * модалка.
 */

import {
  Download,
  Share,
  SquarePlus,
  Compass,
  MonitorDown,
  Check,
} from 'lucide-react'
import type { InstallPlatform } from '@/lib/use-install-prompt'

interface Step {
  icon: React.ReactNode
  text: React.ReactNode
}

/** Заголовок и шаги под конкретную платформу. */
export function instructionsFor(platform: InstallPlatform): {
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

export function InstallInstructionsDialog({
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
