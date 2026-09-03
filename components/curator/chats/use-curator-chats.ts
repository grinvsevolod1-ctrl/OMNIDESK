'use client'

/**
 * Состояние раздела «Чаты» куратора: выбор активного диалога, локальный кэш
 * сообщений с оптимистичными апдейтами, реалтайм через общий /api/stream
 * (события уже приходят скоупленные по curator_id — см. app/api/stream),
 * и обработчики отправки (текст + фото/файл). Намеренно проще менеджерского
 * useInbox: у куратора нет реакций/пересылки/стикеров/голосовых/расписания —
 * только чтение истории и ответ текстом или вложением.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import type { Conversation, Message } from '@/lib/types'
import { useInboxRealtime } from '@/components/manager/inbox/use-inbox-realtime'
import {
  loadCuratorThreadMessagesAction,
  loadOlderCuratorMessagesAction,
  markCuratorConversationReadAction,
  sendCuratorMessageAction,
} from '@/app/actions/curator-messages'

export function useCuratorChats({
  conversations,
  messagesByConversation,
  currentUser,
}: {
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  currentUser: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [activeId, setActiveId] = useState<string | null>(
    conversations[0]?.id ?? null,
  )
  const [localMessages, setLocalMessages] = useState<
    Record<string, Message[]>
  >(messagesByConversation)
  const [threadLoading, setThreadLoading] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [noOlder, setNoOlder] = useState<Record<string, boolean>>({})
  // Цель ответа-цитаты (как в Telegram): выбранное сообщение показывается над
  // композером и уходит в send как replyToMessageId. Сбрасывается при смене
  // диалога и после отправки.
  const [replyTarget, setReplyTarget] = useState<Message | null>(null)

  // Держим локальный кэш в синхроне с новыми SSR-данными (router.refresh).
  // Тот же паттерн «производное от пропсов», что и в useInbox менеджера —
  // синхронный setState здесь осознан (см. use-inbox.ts).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalMessages((prev) => {
      const next = { ...prev }
      for (const [id, msgs] of Object.entries(messagesByConversation)) {
        // Свежие серверные данные заменяют локальные, кроме tmp-оптимистичных.
        next[id] = msgs
      }
      return next
    })
  }, [messagesByConversation])

  const { syncState } = useInboxRealtime({ router, setLocalMessages })

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  )
  const thread = activeId ? (localMessages[activeId] ?? []) : []

  // Холодный диалог (вне SSR-слайса): догружаем историю при первом открытии.
  const hydratedRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    if (!activeId) return
    if (hydratedRef.current.has(activeId)) return
    if ((localMessages[activeId]?.length ?? 0) > 0) {
      hydratedRef.current.add(activeId)
      return
    }
    hydratedRef.current.add(activeId)
    const id = activeId
    // setState держим внутри транзишена (не напрямую в теле эффекта), чтобы не
    // нарушать react-hooks/set-state-in-effect и не гонять лишний ре-рендер.
    startTransition(async () => {
      setThreadLoading(true)
      const res = await loadCuratorThreadMessagesAction(id)
      if (res.ok) {
        setLocalMessages((prev) => ({ ...prev, [id]: res.messages }))
      }
      setThreadLoading(false)
    })
  }, [activeId, localMessages])

  // Отметить прочитанным при открытии (best-effort) + сбросить черновик ответа.
  useEffect(() => {
    if (!activeId) return
    const id = activeId
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReplyTarget(null)
    void markCuratorConversationReadAction(id).catch(() => {})
  }, [activeId])

  const loadOlder = useCallback(() => {
    if (!activeId || loadingOlder) return
    const id = activeId
    const oldest = (localMessages[id] ?? [])[0]
    if (!oldest) return
    setLoadingOlder(true)
    startTransition(async () => {
      const res = await loadOlderCuratorMessagesAction(id, oldest.createdAt)
      if (res.ok) {
        setLocalMessages((prev) => ({
          ...prev,
          [id]: [...res.messages, ...(prev[id] ?? [])],
        }))
        if (!res.hasMore) setNoOlder((p) => ({ ...p, [id]: true }))
      }
      setLoadingOlder(false)
    })
  }, [activeId, loadingOlder, localMessages])

  const handleSend = useCallback(
    (text: string) => {
      if (!activeId) return
      const body = text.trim()
      if (!body) return
      const id = activeId
      const reply = replyTarget
      const optimistic: Message = {
        id: `tmp_${Date.now()}`,
        conversationId: id,
        direction: 'out',
        body,
        author: currentUser,
        createdAt: new Date().toISOString(),
        status: 'sent',
        // Оптимистичная цитата — сразу показываем в баббле до ответа сервера.
        replyTo: reply
          ? {
              id: reply.id,
              author: reply.author ?? '',
              body: reply.body ?? '',
              mediaType: reply.mediaType,
            }
          : undefined,
      }
      setLocalMessages((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), optimistic],
      }))
      setReplyTarget(null)
      startTransition(async () => {
        const res = await sendCuratorMessageAction(id, body, reply?.id)
        if (!res.ok) toast.error(res.message)
      })
    },
    [activeId, currentUser, replyTarget],
  )

  // Выбрать сообщение для ответа-цитаты (из контекстного меню бабла).
  const handleReply = useCallback((message: Message) => {
    setReplyTarget(message)
  }, [])

  // Копировать текст сообщения в буфер обмена.
  const handleCopy = useCallback((message: Message) => {
    const text = message.body ?? ''
    if (!text) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success('Скопировано'))
      .catch(() => toast.error('Не удалось скопировать'))
  }, [])

  // Прикрепить и отправить файл (WhatsApp/VK) через curator-media API-роут.
  // Telegram-медиа в объём куратора не входит — кнопка появляется только для
  // whatsapp/vk (см. композер). Ответ прилетит обратно по SSE.
  const handleSendMediaFile = useCallback(
    (file: File, caption: string) => {
      if (!activeId || !active) return
      const channelType = active.channelType
      if (channelType !== 'whatsapp' && channelType !== 'vk') return
      const MAX_UPLOAD_BYTES = 200 * 1024 * 1024
      if (file.size > MAX_UPLOAD_BYTES) {
        toast.error('Файл слишком большой (максимум 200 МБ).')
        return
      }
      const fd = new FormData()
      fd.append('conversationId', activeId)
      fd.append('channel', channelType)
      fd.append('file', file)
      const trimmed = caption.trim()
      if (trimmed) fd.append('caption', trimmed)
      startTransition(async () => {
        try {
          const resp = await fetch('/api/curator-media/upload', {
            method: 'POST',
            body: fd,
          })
          let res: { ok?: boolean; message?: string } = {}
          try {
            res = (await resp.json()) as typeof res
          } catch {
            /* не-JSON (обрезано прокси) — по статусу ниже */
          }
          if (resp.ok && res.ok) {
            toast.success(res.message ?? 'Файл отправлен.')
          } else {
            toast.error(
              res.message ??
                (resp.status === 413
                  ? 'Файл слишком большой для сервера.'
                  : 'Не удалось отправить файл. Попробуйте ещё раз.'),
            )
          }
        } catch (err) {
          console.error('[v0] curator media upload failed:', err)
          toast.error('Сеть прервала загрузку. Попробуйте снова.')
        }
      })
    },
    [activeId, active],
  )

  return {
    activeId,
    setActiveId,
    active,
    thread,
    threadLoading,
    loadingOlder,
    noOlder,
    loadOlder,
    handleSend,
    handleSendMediaFile,
    replyTarget,
    setReplyTarget,
    handleReply,
    handleCopy,
    pending,
    syncState,
  }
}
