'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { BellRing, Loader2, Send, Stethoscope } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  getPushConfigAction,
  getPushDiagnosticsAction,
  sendTestPushAction,
  unsubscribePushAction,
} from '@/app/actions/push'
import { ensurePushSubscription, keyMatches } from '@/lib/push-client'

interface DiagLine {
  label: string
  ok: boolean
  detail?: string
}

type State =
  | 'checking'
  | 'unsupported'
  | 'unconfigured'
  | 'default'
  | 'denied'
  | 'subscribed'

export function NotificationSettings() {
  const [state, setState] = useState<State>('checking')
  const [busy, setBusy] = useState(false)
  const [diag, setDiag] = useState<DiagLine[] | null>(null)
  const publicKeyRef = useRef<string>('')

  const refresh = useCallback(async () => {
    if (
      typeof window === 'undefined' ||
      !('serviceWorker' in navigator) ||
      !('Notification' in window) ||
      !('PushManager' in window)
    ) {
      setState('unsupported')
      return
    }
    let config: { configured: boolean; publicKey: string }
    try {
      config = await getPushConfigAction()
    } catch {
      setState('unsupported')
      return
    }
    publicKeyRef.current = config.publicKey
    if (!config.configured) {
      setState('unconfigured')
      return
    }
    const perm = Notification.permission
    if (perm === 'denied') {
      setState('denied')
      return
    }
    const reg = await navigator.serviceWorker.ready.catch(() => null)
    const existing = reg ? await reg.pushManager.getSubscription() : null
    if (perm === 'granted' && existing) setState('subscribed')
    else setState('default')
  }, [])

  useEffect(() => {
    // Sync notification permission/subscription state from the browser on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
  }, [refresh])

  const enable = useCallback(async () => {
    setBusy(true)
    try {
      await navigator.serviceWorker.register('/sw.js').catch(() => {})
      const perm = await Notification.requestPermission()
      if (perm !== 'granted') {
        toast.error('Разрешение не предоставлено.')
        await refresh()
        return
      }
      const res = await ensurePushSubscription(publicKeyRef.current)
      toast[res.ok ? 'success' : 'error'](res.message)
      await refresh()
    } catch {
      toast.error('Не удалось включить уведомления.')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const disable = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        await unsubscribePushAction(sub.endpoint)
        await sub.unsubscribe().catch(() => {})
      }
      toast.success('Уведомления отключены на этом устройстве.')
      await refresh()
    } catch {
      toast.error('Не удалось отключить уведомления.')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const test = useCallback(async () => {
    setBusy(true)
    try {
      // Target THIS device: a broadcast test reports success as soon as ANY
      // device gets it, which hides exactly the bug being tested for (this
      // computer silently unsubscribed server-side while another one works).
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (!sub) {
        toast.error('На этом устройстве нет подписки. Включите уведомления.')
        await refresh()
        return
      }
      const res = await sendTestPushAction(sub.endpoint)
      if (res.ok) {
        toast.success(res.message)
        return
      }
      if (!res.needsResubscribe) {
        toast.error(res.message)
        return
      }
      // Server lost/rejected this device's subscription: re-subscribe with
      // the current key and retry the test once, so one click both heals the
      // device and proves delivery works again.
      const healed = await ensurePushSubscription(publicKeyRef.current)
      if (!healed.ok) {
        toast.error(healed.message)
        await refresh()
        return
      }
      const sub2 = await reg.pushManager.getSubscription()
      const retry = sub2 ? await sendTestPushAction(sub2.endpoint) : null
      if (retry?.ok) {
        toast.success('Подписка восстановлена — тест отправлен.')
      } else {
        toast.error(retry?.message ?? 'Не удалось восстановить подписку.')
      }
      await refresh()
    } catch {
      toast.error('Не удалось отправить тест.')
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const diagnose = useCallback(async () => {
    setBusy(true)
    try {
      const lines: DiagLine[] = []
      const server = await getPushDiagnosticsAction()
      lines.push({
        label: 'VAPID-ключи на сервере',
        ok: server.configured,
        detail: server.configured ? undefined : 'Пуши не могут отправляться вообще',
      })

      const perm = Notification.permission
      lines.push({
        label: 'Разрешение браузера',
        ok: perm === 'granted',
        detail: perm !== 'granted' ? `Статус: ${perm}` : undefined,
      })

      const reg = await navigator.serviceWorker.ready.catch(() => null)
      const sub = reg ? await reg.pushManager.getSubscription() : null
      lines.push({
        label: 'Подписка в этом браузере',
        ok: Boolean(sub),
        detail: sub ? undefined : 'Нажмите «Включить уведомления»',
      })

      if (sub) {
        const match = keyMatches(sub, server.publicKey)
        lines.push({
          label: 'Ключ подписки совпадает с сервером',
          ok: match,
          detail: match
            ? undefined
            : 'Подписка создана со старым ключом — нажмите «Отправить тест», он её пересоздаст',
        })

        const registered = server.devices.some((d) => d.endpoint === sub.endpoint)
        lines.push({
          label: 'Это устройство зарегистрировано на сервере',
          ok: registered,
          detail: registered
            ? undefined
            : 'Сервер не знает об этом браузере — «Отправить тест» восстановит регистрацию',
        })
      }

      lines.push({
        label: `Устройств у вас на сервере: ${server.devices.length}`,
        ok: server.devices.length > 0,
        detail:
          server.devices.length === 0
            ? 'Ни одно устройство не получит пуш — включите уведомления заново'
            : undefined,
      })

      setDiag(lines)
      const broken = lines.filter((l) => !l.ok)
      if (broken.length === 0) {
        toast.success(
          'Всё в порядке. Если тест «отправлен», но не показывается — проверьте уведомления Chrome в настройках Windows/macOS (Фокусировка/Do Not Disturb).',
        )
      }
    } catch {
      toast.error('Не удалось выполнить диагностику.')
    } finally {
      setBusy(false)
    }
  }, [])

  if (state === 'checking') {
    return (
      <p className="text-sm text-muted-foreground">Проверяем статус уведомлений…</p>
    )
  }
  if (state === 'unsupported') {
    return (
      <p className="text-sm text-muted-foreground">
        Этот браузер не поддерживает push-уведомления.
      </p>
    )
  }
  if (state === 'unconfigured') {
    return (
      <p className="text-sm text-muted-foreground">
        Push-уведомления ещё не настроены на сервере.
      </p>
    )
  }
  if (state === 'denied') {
    return (
      <p className="text-sm text-muted-foreground">
        Уведомления заблокированы для этого сайта. Разрешите их в настройках
        сайта в браузере и перезагрузите страницу.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-sm">
        <span
          className={
            state === 'subscribed'
              ? 'inline-flex size-2 rounded-full bg-primary'
              : 'inline-flex size-2 rounded-full bg-muted-foreground'
          }
          aria-hidden="true"
        />
        <span className="text-muted-foreground">
          {state === 'subscribed'
            ? 'Включено на этом устройстве.'
            : 'Не включено на этом устройстве.'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {state === 'subscribed' ? (
          <>
            <Button variant="outline" size="sm" onClick={test} disabled={busy}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Отправить тест
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={diagnose}
              disabled={busy}
            >
              <Stethoscope className="size-4" />
              Диагностика
            </Button>
            <Button variant="ghost" size="sm" onClick={disable} disabled={busy}>
              Отключить на этом устройстве
            </Button>
          </>
        ) : (
          <Button size="sm" onClick={enable} disabled={busy}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <BellRing className="size-4" />
            )}
            Включить уведомления
          </Button>
        )}
      </div>
      {diag && (
        <ul className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/30 p-3 text-sm">
          {diag.map((line) => (
            <li key={line.label} className="flex items-start gap-2">
              <span
                className={
                  line.ok
                    ? 'mt-1.5 inline-flex size-2 shrink-0 rounded-full bg-primary'
                    : 'mt-1.5 inline-flex size-2 shrink-0 rounded-full bg-destructive'
                }
                aria-hidden="true"
              />
              <span>
                <span
                  className={line.ok ? 'text-foreground' : 'text-destructive'}
                >
                  {line.label}
                </span>
                {line.detail && (
                  <span className="block text-xs text-muted-foreground">
                    {line.detail}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
