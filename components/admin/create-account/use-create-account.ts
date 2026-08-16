'use client'

/**
 * Логика карточки «Подключить аккаунт»: состояние формы, отправка (Telegram /
 * VK / MAX) и многошаговый Telegram-логин с поллингом статуса (QR / код / 2FA).
 * Презентация — create-account-card.tsx + telegram-login-dialog.tsx.
 */

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import QRCode from 'qrcode'
import { toast } from 'sonner'
import {
  adminConnectMaxAction,
  adminConnectTelegramAction,
  adminConnectTelegramQrAction,
  adminConnectVkAction,
  adminGetTelegramQrAction,
  adminRestartTelegramQrAction,
  adminGetChannelStatusAction,
  adminResendTelegramCodeAction,
  adminSubmitTelegramCodeAction,
  adminSubmitTelegramPasswordAction,
} from '@/app/actions/admin-accounts'
import type { Proxy } from '@/lib/types'
import { proxyEligible, type CreatableType } from '@/components/admin/account-shared'

export type TgStep = 'qr' | 'code' | 'password' | null
export type TgMethod = 'qr' | 'phone'

export function useCreateAccount({
  proxies,
  proxyUsage,
  workerOnline,
  only,
}: {
  proxies: Proxy[]
  proxyUsage: Record<string, string[]>
  workerOnline: boolean
  only?: CreatableType
}) {
  const [type, setType] = useState<CreatableType>(only ?? 'telegram')
  const [managerId, setManagerId] = useState('')
  const [proxyId, setProxyId] = useState('')
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [token, setToken] = useState('')
  const [pending, startTransition] = useTransition()

  // How to log the Telegram account in. QR is the default: no phone number, no
  // SMS wait — the owner scans from Telegram → Settings → Devices. The phone
  // flow stays for accounts that can't scan (e.g. only device IS this login).
  const [tgMethod, setTgMethod] = useState<TgMethod>('qr')
  // Telegram multi-step login state.
  const [tgChannelId, setTgChannelId] = useState<string | null>(null)
  const [tgStep, setTgStep] = useState<TgStep>(null)
  const [tgCode, setTgCode] = useState('')
  const [tgPassword, setTgPassword] = useState('')
  // Rendered QR image (data URL) + the deep link it encodes. The link rotates
  // ~every 30s on the worker, so the poll re-renders only when it changes.
  const [tgQrImage, setTgQrImage] = useState<string | null>(null)
  const tgQrUrlRef = useRef<string | null>(null)
  // Login error shown INSIDE the modal (toasts vanish; the admin needs the
  // reason + a retry button in front of them, not a dead-end spinner).
  const [tgError, setTgError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  // Wall-clock deadline for the login to leave the 'starting' state. If the
  // worker is offline or the job is never claimed, the session status stays
  // 'starting' forever and the code window never appears — so we stop polling
  // and surface a clear error instead of spinning indefinitely.
  const pollDeadlineRef = useRef<number>(0)

  // The poll interval must not outlive the component: navigating away while a
  // login is in flight used to leak the interval and fire setState on an
  // unmounted component.
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  const eligibleProxies = useMemo(
    () => proxies.filter((p) => proxyEligible(p, type, proxyUsage)),
    [proxies, type, proxyUsage],
  )

  function resetForm() {
    setName('')
    setPhone('')
    setToken('')
    setProxyId('')
    setManagerId('')
    setTgChannelId(null)
    setTgStep(null)
    setTgCode('')
    setTgPassword('')
    setTgError(null)
    setTgQrImage(null)
    tgQrUrlRef.current = null
    if (pollRef.current) clearInterval(pollRef.current)
  }

  function validateCommon(): string | null {
    if (!managerId) return 'Выберите менеджера-владельца.'
    // Proxy is optional — an empty proxyId means a direct connection.
    return null
  }

  function pollTelegram(channelId: string) {
    if (pollRef.current) clearInterval(pollRef.current)
    setTgError(null)
    // Allow up to 90s to reach a code/password/online/error state. Requesting
    // the code from Telegram (through the account's proxy) can take a while, but
    // if nothing happens by then the worker is almost certainly not processing
    // the job — tell the admin instead of leaving them staring at a spinner.
    pollDeadlineRef.current = Date.now() + 90_000
    pollRef.current = setInterval(async () => {
      const snap = await adminGetChannelStatusAction(channelId)
      if (!snap) return
      if (snap.sessionStatus === 'qr_pending') {
        setTgStep('qr')
        setTgError(null)
        // The deep link rotates on the worker (~30s TTL): fetch it and re-render
        // the QR image only when the link actually changed.
        const data = await adminGetTelegramQrAction(channelId)
        if (data.qr && data.qr !== tgQrUrlRef.current) {
          tgQrUrlRef.current = data.qr
          const img = await QRCode.toDataURL(data.qr, {
            margin: 1,
            width: 320,
            errorCorrectionLevel: 'M',
          })
          setTgQrImage(img)
        }
        // The scan can happen at any moment — extend the deadline while the
        // QR is displayed so the wizard never times out mid-wait.
        pollDeadlineRef.current = Date.now() + 90_000
      } else if (snap.sessionStatus === 'code_pending') {
        setTgStep('code')
        setTgError(null)
      } else if (snap.sessionStatus === 'password_pending') {
        setTgStep('password')
        setTgError(null)
      } else if (snap.sessionStatus === 'online') {
        if (pollRef.current) clearInterval(pollRef.current)
        toast.success('Telegram-аккаунт подключён.')
        resetForm()
      } else if (
        snap.sessionStatus === 'error' ||
        snap.sessionStatus === 'logged_out'
      ) {
        // Keep the modal alive with the error + retry actions. Polling stops,
        // but submitCode/resend restart it — previously the flow was dead here.
        if (pollRef.current) clearInterval(pollRef.current)
        setTgError(snap.lastError || 'Не удалось подключить Telegram.')
      } else if (
        // Still 'starting'/'idle' past the deadline → the worker never picked
        // up the job. Stop and explain, so the flow doesn't hang forever.
        Date.now() > pollDeadlineRef.current &&
        (snap.sessionStatus === 'starting' || snap.sessionStatus === 'idle')
      ) {
        if (pollRef.current) clearInterval(pollRef.current)
        setTgError(
          'Telegram не ответил. Убедитесь, что процесс воркера запущен на VPS и подключён к базе, затем запросите код повторно.',
        )
      }
    }, 2000)
  }

  /**
   * Retry the login on the existing channel and resume polling. QR attempts
   * restart the QR flow (fresh token), phone attempts re-request the SMS code.
   */
  function retryLogin() {
    if (!tgChannelId) return
    startTransition(async () => {
      const res =
        tgMethod === 'qr'
          ? await adminRestartTelegramQrAction(tgChannelId)
          : await adminResendTelegramCodeAction(tgChannelId)
      if (!res.ok) {
        setTgError(res.message)
        return
      }
      toast.message(res.message)
      setTgStep(null)
      setTgCode('')
      setTgQrImage(null)
      tgQrUrlRef.current = null
      pollTelegram(tgChannelId)
    })
  }

  function submitCreate() {
    const err = validateCommon()
    if (err) {
      toast.error(err)
      return
    }
    const fd = new FormData()
    fd.set('managerId', managerId)
    fd.set('proxyId', proxyId)
    fd.set('name', name)

    startTransition(async () => {
      if (type === 'telegram') {
        // Telegram login is driven entirely by the worker (MTProto). If it's
        // offline the job will queue but never run, so the QR/code window
        // would never appear. Block up-front with a clear reason instead.
        if (!workerOnline) {
          toast.error(
            'Воркер не в сети. Telegram-вход требует запущенного процесса воркера на VPS — запустите его и повторите.',
          )
          return
        }
        if (tgMethod === 'phone' && !phone.trim()) {
          toast.error('Введите номер телефона.')
          return
        }
        if (tgMethod === 'phone') fd.set('phone', phone)
        const res =
          tgMethod === 'qr'
            ? await adminConnectTelegramQrAction(fd)
            : await adminConnectTelegramAction(fd)
        if (!res.ok) {
          toast.error(res.message)
          return
        }
        toast.message(res.message)
        if (res.channelId) {
          setTgChannelId(res.channelId)
          pollTelegram(res.channelId)
        }
      } else if (type === 'vk') {
        if (!token.trim()) {
          toast.error('Вставьте токен сообщества VK.')
          return
        }
        fd.set('token', token)
        const res = await adminConnectVkAction(fd)
        if (!res.ok) {
          toast.error(res.message)
          return
        }
        toast.success(res.message)
        resetForm()
      } else {
        if (!token.trim()) {
          toast.error('Вставьте токен бота MAX.')
          return
        }
        fd.set('token', token)
        const res = await adminConnectMaxAction(fd)
        if (!res.ok) {
          toast.error(res.message)
          return
        }
        toast.success(res.message)
        resetForm()
      }
    })
  }

  function submitCode() {
    if (!tgChannelId || !tgCode.trim()) return
    startTransition(async () => {
      const res = await adminSubmitTelegramCodeAction(tgChannelId, tgCode)
      if (!res.ok) toast.error(res.message)
      else {
        toast.message(res.message)
        setTgCode('')
        // The previous poll may have stopped on an earlier error (wrong code):
        // always restart it so the outcome of THIS attempt reaches the UI.
        pollTelegram(tgChannelId)
      }
    })
  }

  function submitPassword() {
    if (!tgChannelId || !tgPassword.trim()) return
    startTransition(async () => {
      const res = await adminSubmitTelegramPasswordAction(
        tgChannelId,
        tgPassword,
      )
      if (!res.ok) toast.error(res.message)
      else {
        toast.message(res.message)
        setTgPassword('')
        // Same as submitCode: make sure a live poll is watching this attempt.
        pollTelegram(tgChannelId)
      }
    })
  }

  return {
    // form state
    type,
    setType,
    managerId,
    setManagerId,
    proxyId,
    setProxyId,
    name,
    setName,
    phone,
    setPhone,
    token,
    setToken,
    pending,
    eligibleProxies,
    // telegram login state
    tgMethod,
    setTgMethod,
    tgChannelId,
    tgStep,
    tgCode,
    setTgCode,
    tgPassword,
    setTgPassword,
    tgQrImage,
    tgError,
    // actions
    submitCreate,
    submitCode,
    submitPassword,
    retryLogin,
    resetForm,
  }
}
