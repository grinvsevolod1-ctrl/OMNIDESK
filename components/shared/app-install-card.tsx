'use client'

/**
 * Постоянная точка входа «Установить приложение» в настройках любой роли.
 * В отличие от нижнего приглашения (pwa-install-prompt), которое можно закрыть
 * на 14 дней, эта карточка всегда доступна на странице настроек — сюда идёт
 * пользователь, который решил установить приложение осознанно.
 *
 * Сама себя прячет, когда действовать не нужно: в уже установленном приложении
 * (standalone) и в браузере без поддержки установки. Логика платформы/окна —
 * в useInstallPrompt(); пошаговая инструкция — общий pwa-install-dialog.
 */

import { useState } from 'react'
import { Download, Smartphone } from 'lucide-react'
import { useInstallPrompt } from '@/lib/use-install-prompt'
import { InstallInstructionsDialog } from '@/components/pwa-install-dialog'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'

/** Короткое пояснение под заголовком в зависимости от платформы. */
function hintFor(canPromptNative: boolean): string {
  return canPromptNative
    ? 'Установите приложение на устройство — быстрый доступ с экрана «Домой» и надёжные push-уведомления даже при закрытой вкладке.'
    : 'Добавьте приложение на устройство — быстрый доступ с экрана «Домой» и надёжные push-уведомления. Покажем, как это сделать в вашем браузере.'
}

export function AppInstallCard() {
  const { platform, canPromptNative, installable, promptInstall } =
    useInstallPrompt()
  const [dialogOpen, setDialogOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  // Нечего предлагать: уже установлено или браузер без поддержки.
  if (!installable) return null

  const handleClick = async () => {
    if (canPromptNative) {
      setBusy(true)
      try {
        await promptInstall()
      } finally {
        setBusy(false)
      }
      return
    }
    setDialogOpen(true)
  }

  return (
    <>
      <Card className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
            <Smartphone className="size-5" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <h2 className="font-medium">Установить приложение</h2>
            <p className="mt-0.5 text-sm text-muted-foreground text-pretty">
              {hintFor(canPromptNative)}
            </p>
          </div>
        </div>
        <Button
          type="button"
          onClick={() => void handleClick()}
          disabled={busy}
          className="shrink-0 sm:self-center"
        >
          <Download className="size-4" />
          {canPromptNative ? 'Установить' : 'Как установить'}
        </Button>
      </Card>

      <InstallInstructionsDialog
        open={dialogOpen}
        platform={platform}
        onClose={() => setDialogOpen(false)}
      />
    </>
  )
}
