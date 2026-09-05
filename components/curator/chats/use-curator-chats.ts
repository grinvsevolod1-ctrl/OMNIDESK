'use client'

/**
 * Состояние раздела «Чаты» куратора: выбор активного диалога, локальный кэш
 * сообщений с оптимистичными апдейтами, реалтайм через общий /api/stream
 * (события уже приходят скоупленные по curator_id — см. app/api/stream), и
 * ПОЛНЫЙ набор действий менеджера: отправка/ответ/редактирование/удаление/
 * реакции/пересылка/стикеры/голосовые/отложенная отправка + фото/файлы. Все
 * серверные экшены скоуплены по curator_id (см. app/actions/curator-messages),
 * поэтому куратор действует только в ПЕРЕДАННЫХ ему диалогах; доставка идёт
 * через воркер под owner-менеджером канала.
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
import type { Conversation, Message, StickerItem } from '@/lib/types'
import type { ForwardTarget } from '@/components/manager/message-context-menu'
import { useInboxRealtime } from '@/components/manager/inbox/use-inbox-realtime'
import {
  deleteCuratorMessageAction,
  editCuratorMessageAction,
  forwardCuratorMessageAction,
  loadCuratorThreadMessagesAction,
  loadOlderCuratorMessagesAction,
  markCuratorConversationReadAction,
  reactCuratorMessageAction,
  sendCuratorMessageAction,
  sendCuratorScheduledMessageAction,
  sendCuratorStickerAction,
  sendCuratorTelegramMediaAction,
  sendCuratorVoiceAction,
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
  // Редактируемое сообщение (только своё исходящее, Telegram). Взаимоисключимо
  // с replyTarget — как у менеджера.
  const [editTarget, setEditTarget] = useState<Message | null>(null)

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
    setEditTarget(null)
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

      // Режим редактирования: перезаписываем баббл оптимистично, шлём правку,
      // откатываем при ошибке. Полное зеркало менеджерского useMessageActions.
      if (editTarget) {
        const target = editTarget
        const prevBody = target.body ?? ''
        if (body === prevBody.trim()) {
          setEditTarget(null)
          return
        }
        setLocalMessages((prev) => ({
          ...prev,
          [id]: (prev[id] ?? []).map((m) =>
            m.id === target.id
              ? {
                  ...m,
                  body,
                  editedAt: new Date().toISOString(),
                  editCount: (m.editCount ?? 0) + 1,
                }
              : m,
          ),
        }))
        setEditTarget(null)
        startTransition(async () => {
          const res = await editCuratorMessageAction(target.id, body)
          if (!res.ok) {
            toast.error(res.message)
            setLocalMessages((prev) => ({
              ...prev,
              [id]: (prev[id] ?? []).map((m) =>
                m.id === target.id ? { ...m, body: prevBody } : m,
              ),
            }))
          }
        })
        return
      }

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
    [activeId, currentUser, replyTarget, editTarget],
  )

  // Выбрать сообщение для ответа-цитаты (из контекстного меню бабла).
  const handleReply = useCallback((message: Message) => {
    setEditTarget(null)
    setReplyTarget(message)
  }, [])

  // Начать редактирование своего исходящего сообщения (Telegram).
  const handleEdit = useCallback((message: Message) => {
    setReplyTarget(null)
    setEditTarget(message)
  }, [])

  // Реакция-эмодзи на сообщение (Telegram), оптимистично.
  const reactTo = useCallback(
    (message: Message, emoji: string) => {
      if (!activeId) return
      const id = activeId
      setLocalMessages((prev) => ({
        ...prev,
        [id]: (prev[id] ?? []).map((m) => {
          if (m.id !== message.id) return m
          const others = (m.reactions ?? []).filter((r) => !r.fromMe)
          const reactions = emoji
            ? [...others, { emoji, fromMe: true }]
            : others
          return { ...m, reactions: reactions.length ? reactions : undefined }
        }),
      }))
      startTransition(async () => {
        const res = await reactCuratorMessageAction(message.id, emoji)
        if (!res.ok) toast.error(res.message)
      })
    },
    [activeId],
  )

  // Удалить сообщение у всех (Telegram), оптимистично.
  const deleteMessage = useCallback(
    (message: Message) => {
      if (!activeId) return
      const id = activeId
      setLocalMessages((prev) => ({
        ...prev,
        [id]: (prev[id] ?? []).map((m) =>
          m.id === message.id
            ? {
                ...m,
                body: '',
                deletedAt: new Date().toISOString(),
                reactions: undefined,
              }
            : m,
        ),
      }))
      startTransition(async () => {
        const res = await deleteCuratorMessageAction(message.id)
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      })
    },
    [activeId],
  )

  // Переслать сообщение в другой переданный куратору Telegram-диалог.
  const forwardMessage = useCallback(
    (message: Message, toConversationId: string) => {
      startTransition(async () => {
        const res = await forwardCuratorMessageAction(
          message.id,
          toConversationId,
        )
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      })
    },
    [],
  )

  // Отправить стикер (Telegram), оптимистично.
  const sendSticker = useCallback(
    (sticker: StickerItem) => {
      if (!activeId) return
      const id = activeId
      const optimistic: Message = {
        id: `tmp_${Date.now()}`,
        conversationId: id,
        direction: 'out',
        body: sticker.emoji || '[Стикер]',
        author: currentUser,
        createdAt: new Date().toISOString(),
        status: 'sent',
        mediaType: 'sticker',
        mediaMime: sticker.mime,
      }
      setLocalMessages((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), optimistic],
      }))
      startTransition(async () => {
        const res = await sendCuratorStickerAction(id, sticker)
        if (!res.ok) toast.error(res.message)
      })
    },
    [activeId, currentUser],
  )

  // Отправить голосовое (Telegram), оптимистично.
  const sendVoice = useCallback(
    (audio: { base64: string; mime: string; durationSec: number }) => {
      if (!activeId) return
      const id = activeId
      const optimistic: Message = {
        id: `tmp_${Date.now()}`,
        conversationId: id,
        direction: 'out',
        body: '[Голосовое сообщение]',
        author: currentUser,
        createdAt: new Date().toISOString(),
        status: 'sent',
        mediaType: 'voice',
        mediaMime: audio.mime,
      }
      setLocalMessages((prev) => ({
        ...prev,
        [id]: [...(prev[id] ?? []), optimistic],
      }))
      startTransition(async () => {
        const res = await sendCuratorVoiceAction(id, audio)
        if (!res.ok) toast.error(res.message)
      })
    },
    [activeId, currentUser],
  )

  // Отложенная отправка (Telegram). Без оптимистичного баббла — строка
  // приедет обычным revalidate с превью «[Запланировано на …]».
  const scheduleSend = useCallback(
    (body: string, scheduleAtIso: string) => {
      if (!activeId) return
      const id = activeId
      startTransition(async () => {
        const res = await sendCuratorScheduledMessageAction(
          id,
          body,
          scheduleAtIso,
        )
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      })
    },
    [activeId],
  )

  // Цели пересылки: остальные переданные куратору Telegram-диалоги.
  const forwardTargets: ForwardTarget[] = useMemo(
    () =>
      conversations
        .filter((c) => c.channelType === 'telegram' && c.id !== activeId)
        .map((c) => ({ id: c.id, name: c.contactName })),
    [conversations, activeId],
  )

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
      // Telegram media rides the MTProto session via a worker job (base64),
      // with a tighter ~15 MB cap; WA/VK use the CDN upload route below.
      if (channelType === 'telegram') {
        const TG_MAX_BYTES = 15 * 1024 * 1024
        if (file.size > TG_MAX_BYTES) {
          toast.error('Файл слишком большой для Telegram (максимум ~15 МБ).')
          return
        }
        startTransition(async () => {
          try {
            const reader = new FileReader()
            const base64: string = await new Promise((resolve, reject) => {
              reader.onload = () => {
                const dataUrl = String(reader.result)
                resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
              }
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(file)
            })
            const res = await sendCuratorTelegramMediaAction(
              activeId,
              { base64, mime: file.type || 'application/octet-stream', name: file.name },
              caption,
            )
            if (res.ok) toast.success(res.message ?? 'Файл отправлен.')
            else toast.error(res.message ?? 'Не удалось отправить файл.')
          } catch (err) {
            console.error('[v0] curator telegram media send failed:', err)
            toast.error('Не удалось отправить файл. Попробуйте ещё раз.')
          }
        })
        return
      }
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
    editTarget,
    setEditTarget,
    handleReply,
    handleEdit,
    handleCopy,
    reactTo,
    deleteMessage,
    forwardMessage,
    forwardTargets,
    sendSticker,
    sendVoice,
    scheduleSend,
    pending,
    syncState,
  }
}
