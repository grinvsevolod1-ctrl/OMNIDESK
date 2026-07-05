'use client'

import type { ReactNode } from 'react'
import {
  BellRing,
  Loader2,
  ShieldAlert,
  Smartphone,
  TriangleAlert,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useNotifications } from '@/components/manager/notification-provider'

/**
 * Hard gate: the manager workspace is unusable until push notifications are
 * actually enabled on this device. While capabilities are still being detected
 * we show a neutral loader; once detection finishes we either render the app
 * (notifications active) or a blocking screen explaining how to proceed.
 */
export function NotificationGate({ children }: { children: ReactNode }) {
  const { support, permission, busy, ready, loading, enable } =
    useNotifications()

  if (loading) {
    return (
      <div className="flex h-full min-h-[60vh] items-center justify-center">
        <div className="flex flex-col items-center gap-3 text-muted-foreground">
          <Loader2 className="size-6 animate-spin" />
          <p className="text-sm">Проверяем уведомления…</p>
        </div>
      </div>
    )
  }

  if (ready) return <>{children}</>

  const denied = support === 'ok' && permission === 'denied'
  const iosInstall = support === 'ios-needs-install'
  const unsupported = support === 'unsupported'
  const canEnable = support === 'ok' && permission !== 'denied'

  let Icon = BellRing
  let tone = 'primary'
  let title = 'Включите уведомления, чтобы продолжить'
  let description =
    'Рабочее место менеджера работает только при включённых push-уведомлениях. Так вы не пропустите ни одного нового сообщения — оповещения приходят даже когда вкладка закрыта.'

  if (denied) {
    Icon = ShieldAlert
    tone = 'destructive'
    title = 'Уведомления заблокированы'
    description =
      'Ранее вы запретили уведомления для этого сайта. Откройте настройки сайта в браузере (значок слева от адреса), разрешите «Уведомления» и обновите страницу — без них доступ к рабочему месту закрыт.'
  } else if (iosInstall) {
    Icon = Smartphone
    tone = 'primary'
    title = 'Добавьте Omnidesk на главный экран'
    description =
      'На iPhone или iPad уведомления доступны только из установленного приложения. Откройте меню «Поделиться» в Safari, выберите «На экран „Домой“», затем запустите Omnidesk с домашнего экрана и включите уведомления.'
  } else if (unsupported) {
    Icon = TriangleAlert
    tone = 'destructive'
    title = 'Браузер не поддерживает уведомления'
    description =
      'Этот браузер или устройство не поддерживает push-уведомления, поэтому доступ к рабочему месту закрыт. Откройте Omnidesk в актуальной версии Chrome, Edge, Firefox или Safari на компьютере либо Android-устройстве.'
  }

  return (
    <div className="flex h-full min-h-[70vh] items-center justify-center p-4">
      <section
        role="alertdialog"
        aria-label={title}
        className="w-full max-w-md rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-8"
      >
        <span
          className={
            tone === 'destructive'
              ? 'mx-auto flex size-14 items-center justify-center rounded-2xl bg-destructive/15 text-destructive'
              : 'mx-auto flex size-14 items-center justify-center rounded-2xl bg-primary/15 text-primary'
          }
          aria-hidden="true"
        >
          <Icon className="size-7" />
        </span>

        <h1 className="mt-5 text-balance text-lg font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p className="mt-2 text-pretty text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>

        {canEnable ? (
          <Button
            onClick={() => void enable()}
            disabled={busy}
            size="lg"
            className="mt-6 w-full"
          >
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Включаем…
              </>
            ) : (
              <>
                <BellRing className="size-4" />
                Включить уведомления
              </>
            )}
          </Button>
        ) : (
          <Button
            onClick={() => window.location.reload()}
            variant="outline"
            size="lg"
            className="mt-6 w-full"
          >
            Обновить страницу
          </Button>
        )}

        <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
          Доступ к диалогам, лидам и подключениям откроется сразу после включения
          уведомлений.
        </p>
      </section>
    </div>
  )
}
