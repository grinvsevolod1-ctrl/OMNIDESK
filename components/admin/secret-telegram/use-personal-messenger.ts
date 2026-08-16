'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import {
  personalDialogsAction,
  personalHistoryAction,
  personalMarkReadAction,
  personalSendTextAction,
  personalSendFileAction,
  personalSendVoiceAction,
  personalEditMessageAction,
  personalDeleteMessageAction,
  type PersonalDialog,
  type PersonalMessage,
} from '@/app/actions/admin-secret/telegram-personal'

/**
 * Состояние живого мессенджера личного аккаунта. Всё стателесс: диалоги и
 * история читаются с worker'а при каждом поллинге, на сервере панели ничего
 * не оседает. Realtime — поллинг (тред 3с, список 10с), пауза при скрытой
 * вкладке: SSE не нужен, потому что серверного состояния не существует.
 */
export function usePersonalMessenger(channelId: string | null) {
  const [dialogs, setDialogs] = useState<PersonalDialog[]>([])
  const [dialogsLoading, setDialogsLoading] = useState(false)
  const [dialogsError, setDialogsError] = useState<string | null>(null)
  const [peer, setPeer] = useState<string | null>(null)
  const [messages, setMessages] = useState<PersonalMessage[]>([])
  const [threadLoading, setThreadLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [sending, setSending] = useState(false)

  // Против гонок: поздний ответ старого треда не должен перетереть новый.
  const threadKeyRef = useRef('')

  /* ------------------------------ Диалоги ------------------------------ */

  const refreshDialogs = useCallback(async () => {
    if (!channelId) return
    const res = await personalDialogsAction(channelId)
    if (res.ok) {
      setDialogs(res.dialogs)
      setDialogsError(null)
    } else {
      setDialogsError(res.error ?? 'Сессия недоступна')
    }
  }, [channelId])

  useEffect(() => {
    // Все setState отложены в макротаск: синхронный setState в эффекте —
    // каскадный рендер (правило React Compiler), а данные идут по сети.
    let cancelled = false
    const kick = setTimeout(() => {
      if (cancelled) return
      if (!channelId) {
        setDialogs([])
        setPeer(null)
        return
      }
      setDialogsLoading(true)
      setDialogsError(null)
      void personalDialogsAction(channelId).then((res) => {
        if (cancelled) return
        setDialogsLoading(false)
        if (res.ok) setDialogs(res.dialogs)
        else setDialogsError(res.error ?? 'Сессия недоступна')
      })
    }, 0)
    if (!channelId) return () => clearTimeout(kick)
    const t = setInterval(() => {
      if (document.hidden) return
      void refreshDialogs()
    }, 10_000)
    return () => {
      cancelled = true
      clearTimeout(kick)
      clearInterval(t)
    }
  }, [channelId, refreshDialogs])

  /* ------------------------------- Тред -------------------------------- */

  /**
   * Мердж поллинга с локальной историей: свежая страница — источник правды
   * для своего диапазона id (ловит правки и удаления), догруженные старые
   * сообщения ниже диапазона сохраняются.
   */
  const mergeLatest = useCallback((latest: PersonalMessage[]) => {
    setMessages((prev) => {
      if (latest.length === 0) return prev
      const minId = Math.min(...latest.map((m) => Number(m.id)))
      const older = prev.filter((m) => Number(m.id) < minId)
      return [...older, ...latest]
    })
  }, [])

  useEffect(() => {
    // Ключ гонки ставится СИНХРОННО (иначе поздний ответ старого треда успеет
    // пролезть), сами setState — в макротаске (правило React Compiler).
    const key = channelId && peer ? `${channelId}:${peer}` : ''
    threadKeyRef.current = key
    if (!channelId || !peer) {
      const kick = setTimeout(() => {
        setMessages([])
        setHasMore(true)
      }, 0)
      return () => clearTimeout(kick)
    }
    // Первичная загрузка стартует ПОСЛЕ сброса (внутри того же макротаска),
    // чтобы сброс не мог перетереть уже пришедший ответ.
    const kick = setTimeout(() => {
      if (threadKeyRef.current !== key) return
      setThreadLoading(true)
      setMessages([])
      setHasMore(true)
      // Сброс на случай, если предыдущий тред закрыли посреди loadOlder —
      // иначе флаг остаётся true и пагинация нового треда блокируется.
      setLoadingOlder(false)
      void personalHistoryAction(channelId, peer).then((res) => {
        if (threadKeyRef.current !== key) return
        setThreadLoading(false)
        if (res.ok) {
          setMessages(res.messages)
          if (res.messages.length < 40) setHasMore(false)
          // best-effort: убираем непрочитанный бейдж
          void personalMarkReadAction(channelId, peer).catch(() => {})
          setDialogs((prev) =>
            prev.map((d) => (d.peerId === peer ? { ...d, unreadCount: 0 } : d)),
          )
        } else {
          toast.error(res.error ?? 'Не удалось открыть диалог')
        }
      })
    }, 0)
    const t = setInterval(() => {
      if (document.hidden) return
      void personalHistoryAction(channelId, peer).then((res) => {
        if (threadKeyRef.current !== key) return
        if (res.ok) mergeLatest(res.messages)
      })
    }, 3_000)
    return () => {
      clearTimeout(kick)
      clearInterval(t)
    }
  }, [channelId, peer, mergeLatest])

  const loadOlder = useCallback(async () => {
    if (!channelId || !peer || loadingOlder || messages.length === 0) return
    const beforeId = Number(messages[0].id)
    setLoadingOlder(true)
    const key = threadKeyRef.current
    const res = await personalHistoryAction(channelId, peer, beforeId)
    setLoadingOlder(false)
    if (threadKeyRef.current !== key) return
    if (res.ok) {
      if (res.messages.length === 0) setHasMore(false)
      else {
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.id))
          const fresh = res.messages.filter((m) => !known.has(m.id))
          return [...fresh, ...prev]
        })
        if (res.messages.length < 40) setHasMore(false)
      }
    }
  }, [channelId, peer, loadingOlder, messages])

  /* ------------------------------ Отправка ----------------------------- */

  // `peer` в зависимостях вместо бывшего peerRef: threadKeyRef всё равно
  // отбрасывает поздние ответы чужого треда, а ref-запись в рендере ломала
  // правило react-hooks/refs.
  const refreshThreadNow = useCallback(async () => {
    if (!channelId || !peer) return
    const key = threadKeyRef.current
    const res = await personalHistoryAction(channelId, peer)
    if (threadKeyRef.current !== key) return
    if (res.ok) mergeLatest(res.messages)
  }, [channelId, peer, mergeLatest])

  const sendText = useCallback(
    async (text: string, replyToMsgId?: number) => {
      if (!channelId || !peer) return false
      setSending(true)
      const res = await personalSendTextAction(channelId, peer, text, replyToMsgId)
      setSending(false)
      if (!res.ok) {
        toast.error(res.message)
        return false
      }
      void refreshThreadNow()
      return true
    },
    [channelId, peer, refreshThreadNow],
  )

  const sendFile = useCallback(
    async (file: {
      dataB64: string
      name: string
      mime: string | null
      asPhoto: boolean
      caption?: string
      replyToMsgId?: number
    }) => {
      if (!channelId || !peer) return false
      setSending(true)
      const res = await personalSendFileAction(channelId, peer, file)
      setSending(false)
      if (!res.ok) {
        toast.error(res.message)
        return false
      }
      void refreshThreadNow()
      return true
    },
    [channelId, peer, refreshThreadNow],
  )

  const sendVoice = useCallback(
    async (audioB64: string, durationSec: number) => {
      if (!channelId || !peer) return false
      setSending(true)
      const res = await personalSendVoiceAction(channelId, peer, audioB64, durationSec)
      setSending(false)
      if (!res.ok) {
        toast.error(res.message)
        return false
      }
      void refreshThreadNow()
      return true
    },
    [channelId, peer, refreshThreadNow],
  )

  const editMessage = useCallback(
    async (messageId: number, text: string) => {
      if (!channelId || !peer) return false
      const res = await personalEditMessageAction(channelId, peer, messageId, text)
      if (!res.ok) {
        toast.error(res.message)
        return false
      }
      void refreshThreadNow()
      return true
    },
    [channelId, peer, refreshThreadNow],
  )

  const deleteMessage = useCallback(
    async (messageId: number) => {
      if (!channelId || !peer) return false
      const res = await personalDeleteMessageAction(channelId, peer, messageId)
      if (!res.ok) {
        toast.error(res.message)
        return false
      }
      setMessages((prev) => prev.filter((m) => Number(m.id) !== messageId))
      return true
    },
    [channelId, peer],
  )

  return {
    dialogs,
    dialogsLoading,
    dialogsError,
    refreshDialogs,
    peer,
    setPeer,
    messages,
    threadLoading,
    loadingOlder,
    hasMore,
    loadOlder,
    sending,
    sendText,
    sendFile,
    sendVoice,
    editMessage,
    deleteMessage,
  }
}
