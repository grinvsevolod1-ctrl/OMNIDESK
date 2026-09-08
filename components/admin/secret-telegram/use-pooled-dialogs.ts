'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  personalAllDialogsAction,
  type PooledAccount,
  type PooledDialog,
} from '@/app/actions/admin-secret/telegram-personal'

/**
 * Общий пул диалогов: живой список чатов ВСЕХ online личных аккаунтов в одном
 * массиве, помеченных аккаунтом-владельцем. Поллинг раз в 10с, пауза при
 * скрытой вкладке; на сервере панели ничего не оседает (фан-аут на worker).
 * Гонки отсекаются seqRef — поздний ответ старого запроса не перетирает новый.
 */
export function usePooledDialogs() {
  const [dialogs, setDialogs] = useState<PooledDialog[]>([])
  const [accounts, setAccounts] = useState<PooledAccount[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const seqRef = useRef(0)

  const refresh = useCallback(async (opts?: { silent?: boolean }) => {
    const seq = ++seqRef.current
    if (!opts?.silent) setLoading(true)
    try {
      const res = await personalAllDialogsAction()
      if (seqRef.current !== seq) return
      setDialogs(res.dialogs)
      setAccounts(res.accounts)
      setError(null)
    } catch {
      if (seqRef.current === seq) setError('Не удалось загрузить чаты')
    } finally {
      if (seqRef.current === seq) setLoading(false)
    }
  }, [])

  useEffect(() => {
    // Первый прогон через макротаск: синхронный setState в эффекте даёт
    // каскадный рендер (правило React Compiler), данные всё равно едут по сети.
    const kick = setTimeout(() => void refresh({ silent: true }), 0)
    const t = setInterval(() => {
      if (document.hidden) return
      void refresh({ silent: true })
    }, 10_000)
    return () => {
      clearTimeout(kick)
      clearInterval(t)
    }
  }, [refresh])

  /** Оптимистично убрать диалог из пула (после удаления/выхода). */
  const removeDialog = useCallback((accountId: string, peerId: string) => {
    setDialogs((prev) =>
      prev.filter((d) => !(d.accountId === accountId && d.peerId === peerId)),
    )
  }, [])

  /** Оптимистично обнулить бейдж непрочитанных при открытии треда. */
  const markRead = useCallback((accountId: string, peerId: string) => {
    setDialogs((prev) =>
      prev.map((d) =>
        d.accountId === accountId && d.peerId === peerId
          ? { ...d, unreadCount: 0 }
          : d,
      ),
    )
  }, [])

  return { dialogs, accounts, loading, error, refresh, removeDialog, markRead }
}
