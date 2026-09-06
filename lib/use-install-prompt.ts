'use client'

/**
 * Кросс-платформенная логика установки PWA в одном хуке. Зачем он нужен:
 * «просто PWA» не даёт пользователю понятного способа установиться — на Android
 * и десктопе браузер прячет предложение, а на iOS его нет вовсе (только ручной
 * путь Поделиться → На экран «Домой»). Хук унифицирует это:
 *
 *  - ловит `beforeinstallprompt` (Android/десктоп Chrome/Edge) и позволяет
 *    вызвать нативное окно установки в один тап;
 *  - определяет платформу и браузер, чтобы показать точную инструкцию там, где
 *    нативного окна нет (iOS Safari, iOS-в-чужом-браузере, macOS Safari);
 *  - знает, запущены ли мы уже как установленное приложение (standalone) —
 *    тогда приглашать не нужно.
 *
 * Ничего не рендерит: только состояние и один метод `promptInstall()`.
 */

import { useCallback, useEffect, useState } from 'react'

/** Событие Chrome/Edge, дающее отложенный вызов нативного окна установки. */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[]
  readonly userChoice: Promise<{
    outcome: 'accepted' | 'dismissed'
    platform: string
  }>
  prompt: () => Promise<void>
}

/**
 * Платформа, определяющая КАК ставить приложение:
 *  - `native`   — есть перехваченное окно установки, ставим в один тап;
 *  - `ios-safari` — iPhone/iPad в Safari: ручной путь Поделиться → На «Домой»;
 *  - `ios-other`  — iOS в Chrome/Firefox/др.: установка невозможна, нужно
 *                   открыть сайт в Safari (у сторонних браузеров iOS нет A2HS);
 *  - `macos-safari` — Safari на Mac: Файл → «Добавить в Dock» (Sonoma+);
 *  - `desktop`  — десктопный Chrome/Edge без готового события: значок установки
 *                 в адресной строке;
 *  - `unsupported` — установка недоступна (напр. десктопный Firefox).
 */
export type InstallPlatform =
  | 'native'
  | 'ios-safari'
  | 'ios-other'
  | 'macos-safari'
  | 'desktop'
  | 'unsupported'

export interface InstallState {
  /** Приложение уже открыто как установленное (standalone) — не приглашаем. */
  isStandalone: boolean
  /** Определённая платформа/способ установки. */
  platform: InstallPlatform
  /** Можно ли поставить в один тап (есть перехваченное событие). */
  canPromptNative: boolean
  /**
   * Показывать ли приглашение вообще. false, когда мы уже standalone, либо
   * когда платформа установку не поддерживает и подсказывать нечего.
   */
  installable: boolean
  /**
   * Запустить установку. На `native` открывает системное окно и резолвит
   * `true`, если пользователь согласился. На остальных платформах установку
   * автоматически не запустить — возвращает `false`, и вызывающий показывает
   * инструкцию для `platform`.
   */
  promptInstall: () => Promise<boolean>
}

/** Открыто ли приложение как установленное PWA (а не вкладка браузера)? */
function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false
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

/** Грубое определение платформы по userAgent (только для выбора инструкции). */
function detectPlatform(hasNativePrompt: boolean): InstallPlatform {
  if (hasNativePrompt) return 'native'
  if (typeof navigator === 'undefined') return 'unsupported'

  const ua = navigator.userAgent
  const maxTouch =
    'maxTouchPoints' in navigator ? navigator.maxTouchPoints : 0
  // iPadOS 13+ прикидывается «Macintosh» — отличаем по наличию тача.
  const isIpadOs = /Macintosh/.test(ua) && maxTouch > 1
  const isIos = /iPhone|iPad|iPod/.test(ua) || isIpadOs

  if (isIos) {
    // На iOS «Добавить на экран Домой» есть ТОЛЬКО у Safari. Chrome (CriOS),
    // Firefox (FxiOS), Edge (EdgiOS) и прочие используют WebKit, но пункта
    // установки не имеют — им нужно открыть сайт в Safari.
    const isIosSafari = !/CriOS|FxiOS|EdgiOS|OPiOS|mercury/i.test(ua)
    return isIosSafari ? 'ios-safari' : 'ios-other'
  }

  // Десктопный Safari на macOS: «Добавить в Dock» появилось в Sonoma (17).
  const isMac = /Macintosh/.test(ua) && maxTouch <= 1
  const isSafari = /Safari/.test(ua) && !/Chrome|Chromium|Edg|OPR/.test(ua)
  if (isMac && isSafari) return 'macos-safari'

  // Десктопные Chrome/Edge умеют устанавливать, но событие могло не прийти
  // (уже показывали, эвристики движка) — подскажем про значок в адресной
  // строке. Firefox на десктопе установку PWA не поддерживает.
  const isChromium = /Chrome|Chromium|Edg|OPR/.test(ua)
  return isChromium ? 'desktop' : 'unsupported'
}

/**
 * Единый источник правды о возможности установки. Слушает `beforeinstallprompt`
 * и `appinstalled`, реагирует на смену display-mode (установка/запуск как
 * приложение) — состояние всегда актуально.
 */
export function useInstallPrompt(): InstallState {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(
    null,
  )
  const [isStandalone, setIsStandalone] = useState(false)
  const [installedAt, setInstalledAt] = useState(0)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsStandalone(detectStandalone())

    const onBeforeInstall = (e: Event) => {
      // Гасим авто-баннер браузера, чтобы предложить установку в НАШЕМ UI и в
      // нужный момент.
      e.preventDefault()
      setDeferred(e as BeforeInstallPromptEvent)
    }
    const onInstalled = () => {
      setDeferred(null)
      setInstalledAt(Date.now())
      setIsStandalone(detectStandalone())
    }

    window.addEventListener('beforeinstallprompt', onBeforeInstall)
    window.addEventListener('appinstalled', onInstalled)

    // Запуск как приложение может смениться на лету (установили и открыли).
    const mq =
      typeof window.matchMedia === 'function'
        ? window.matchMedia('(display-mode: standalone)')
        : null
    const onDisplayChange = () => setIsStandalone(detectStandalone())
    mq?.addEventListener?.('change', onDisplayChange)

    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall)
      window.removeEventListener('appinstalled', onInstalled)
      mq?.removeEventListener?.('change', onDisplayChange)
    }
  }, [])

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferred) return false
    await deferred.prompt()
    const choice = await deferred.userChoice
    // Событие одноразовое — после показа его нельзя переиспользовать.
    setDeferred(null)
    return choice.outcome === 'accepted'
  }, [deferred])

  const canPromptNative = deferred !== null
  const platform = detectPlatform(canPromptNative)
  // `installedAt` в зависимостях, чтобы пере-вычислить сразу после установки
  // (событие appinstalled пришло раньше, чем сменился display-mode).
  void installedAt
  // Показываем всюду, кроме уже установленного приложения и десктопного
  // браузера без поддержки (там подсказывать нечего). Для `ios-other` подсказка
  // тоже полезна — «откройте сайт в Safari, чтобы установить».
  const installable = !isStandalone && platform !== 'unsupported'

  return {
    isStandalone,
    platform,
    canPromptNative,
    installable,
    promptInstall,
  }
}
