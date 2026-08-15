'use client'

import { useCallback, useRef, useState } from 'react'
import {
  personalGetStatusAction,
  personalSubmitCodeAction,
  personalSubmitPasswordAction,
} from '@/app/actions/admin-secret/telegram-personal'
import {
  secretGmtImportStartAction,
  secretGmtPurchaseDetailsAction,
  secretGmtRequestCodeAction,
} from '@/app/actions/admin-secret'
import type { SessionStatus } from '@/lib/types'

/* ===================================================================== */
/*  Оркестратор автоимпорта: SUCCESS-покупка → god-аккаунт «онлайн»       */
/*                                                                        */
/*  Ведёт весь флоу в браузере (вкладка открыта), переиспользуя серверные */
/*  actions обеих вкладок:                                                */
/*    1. secretGmtImportStartAction — создаёт личный канал + start-логин  */
/*    2. secretGmtRequestCodeAction — просит GMT прислать код в аккаунт   */
/*    3. читает креды из GET /purchases/:id (код + 2FA-пароль)            */
/*    4. personalSubmitCodeAction / personalSubmitPasswordAction          */
/*    5. поллит session_status до 'online'                                */
/*                                                                        */
/*  Всё идемпотентно и устойчиво к повтору: канал дедуплится по номеру,   */
/*  креды перечитываются из GET (повторный request-code даёт conflict).   */
/* ===================================================================== */

export type ImportPhase =
  | 'idle'
  | 'creating' // создаём канал + стартуем логин
  | 'requesting_code' // просим GMT прислать код
  | 'submitting_code' // отправляем код в Telegram
  | 'submitting_password' // отправляем 2FA-пароль
  | 'waiting' // ждём онлайн
  | 'done'
  | 'error'

export interface ImportState {
  phase: ImportPhase
  message: string
  channelId: string | null
  phone: string | null
  error: string | null
}

const IDLE: ImportState = {
  phase: 'idle',
  message: '',
  channelId: null,
  phone: null,
  error: null,
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Ждёт появления кредов у покупки (GMT доставляет код асинхронно). */
async function waitForCredentials(
  purchaseId: number,
  signal: { aborted: boolean },
): Promise<{ code: string; password: string } | null> {
  // До ~40с: код обычно приходит за 5–20с после request-code.
  for (let i = 0; i < 20; i++) {
    if (signal.aborted) return null
    const res = await secretGmtPurchaseDetailsAction(purchaseId).catch(
      () => null,
    )
    const v = res?.ok ? res.data?.verification : null
    if (v?.code) {
      return { code: v.code, password: v.password ?? '' }
    }
    await sleep(2_000)
  }
  return null
}

/** Поллит session_status канала до терминального состояния. */
async function waitForSession(
  channelId: string,
  want: SessionStatus[],
  signal: { aborted: boolean },
  maxTicks = 30,
): Promise<SessionStatus | null> {
  for (let i = 0; i < maxTicks; i++) {
    if (signal.aborted) return null
    const res = await personalGetStatusAction(channelId).catch(() => null)
    if (res) {
      if (want.includes(res.sessionStatus)) return res.sessionStatus
      if (res.sessionStatus === 'error' || res.sessionStatus === 'logged_out') {
        return res.sessionStatus
      }
    }
    await sleep(2_000)
  }
  return null
}

export function useAutoImport(onImported?: () => void) {
  const [state, setState] = useState<ImportState>(IDLE)
  const abortRef = useRef<{ aborted: boolean }>({ aborted: false })

  const reset = useCallback(() => {
    abortRef.current.aborted = true
    setState(IDLE)
  }, [])

  const run = useCallback(
    async (purchaseId: number) => {
      // Новый прогон отменяет предыдущий.
      abortRef.current.aborted = true
      const signal = { aborted: false }
      abortRef.current = signal

      const fail = (error: string) =>
        setState((s) => ({ ...s, phase: 'error', error, message: '' }))

      // 1. Канал + старт логина по номеру.
      setState({
        phase: 'creating',
        message: 'Создаём аккаунт и запрашиваем вход…',
        channelId: null,
        phone: null,
        error: null,
      })
      const start = await secretGmtImportStartAction(purchaseId).catch(
        () => null,
      )
      if (!start) return fail('Сеть недоступна. Повторите импорт.')
      if (!start.ok) return fail(start.message)

      const { channelId, phone } = start.data
      setState((s) => ({ ...s, channelId, phone }))

      // Уже онлайн (переиспользованный канал) — готово.
      if (start.data.sessionStatus === 'online') {
        setState((s) => ({ ...s, phase: 'done', message: 'Уже подключён' }))
        onImported?.()
        return
      }

      // 2. Просим GMT прислать код в приложение купленного аккаунта.
      setState((s) => ({
        ...s,
        phase: 'requesting_code',
        message: 'Запрашиваем код у Get My TG…',
      }))
      // Небольшая пауза — worker должен успеть дойти до code_pending.
      await sleep(1_500)
      const codeReq = await secretGmtRequestCodeAction(purchaseId).catch(
        () => null,
      )
      // conflict (код уже запрашивали) — не фатально, креды прочитаем из GET.
      if (codeReq && !codeReq.ok && !/already|conflict|запрош/i.test(codeReq.message)) {
        // мягкая ошибка: продолжаем, вдруг код всё же придёт
      }

      // 3. Ждём креды (код + пароль) у покупки.
      const creds = await waitForCredentials(purchaseId, signal)
      if (signal.aborted) return
      if (!creds) {
        return fail(
          'Код не пришёл за отведённое время. Запросите код вручную в истории покупок.',
        )
      }

      // Дожидаемся, пока worker перейдёт в code_pending (готов принять код).
      await waitForSession(channelId, ['code_pending'], signal, 10)
      if (signal.aborted) return

      // 4. Отправляем код в Telegram.
      setState((s) => ({
        ...s,
        phase: 'submitting_code',
        message: 'Вводим код в Telegram…',
      }))
      const codeRes = await personalSubmitCodeAction(channelId, creds.code)
      if (!codeRes.ok) return fail(codeRes.message)

      // 5. Ждём: либо сразу онлайн, либо потребуется 2FA-пароль.
      setState((s) => ({
        ...s,
        phase: 'waiting',
        message: 'Проверяем код…',
      }))
      const afterCode = await waitForSession(
        channelId,
        ['online', 'password_pending'],
        signal,
      )
      if (signal.aborted) return

      if (afterCode === 'password_pending') {
        if (!creds.password) {
          return fail(
            'Аккаунт защищён паролем 2FA, но пароль не пришёл. Введите его вручную.',
          )
        }
        setState((s) => ({
          ...s,
          phase: 'submitting_password',
          message: 'Вводим пароль 2FA…',
        }))
        const pwRes = await personalSubmitPasswordAction(
          channelId,
          creds.password,
        )
        if (!pwRes.ok) return fail(pwRes.message)

        setState((s) => ({ ...s, phase: 'waiting', message: 'Завершаем вход…' }))
        const afterPw = await waitForSession(channelId, ['online'], signal)
        if (signal.aborted) return
        if (afterPw !== 'online') {
          return fail('Не удалось войти с паролем 2FA. Проверьте вручную.')
        }
      } else if (afterCode !== 'online') {
        return fail(
          'Вход не завершился. Откройте вкладку Telegram и проверьте статус аккаунта.',
        )
      }

      // Готово — аккаунт онлайн.
      setState((s) => ({
        ...s,
        phase: 'done',
        message: 'Аккаунт добавлен в god-аккаунты',
      }))
      onImported?.()
    },
    [onImported],
  )

  return { state, run, reset }
}
