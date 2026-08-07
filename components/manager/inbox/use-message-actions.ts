'use client'

import { useEffect, useState, type Dispatch, type SetStateAction, type TransitionStartFunction } from 'react'
import { toast } from 'sonner'
import {
  sendMessageAction,
  sendScheduledMessageAction,
  sendStickerAction,
  sendVoiceAction,
} from '@/app/actions/account'
import {
  replyMessageAction,
  reactMessageAction,
  deleteMessageAction,
  editMessageAction,
  forwardMessageAction,
} from '@/app/actions/messages'
import type { Conversation, Message, StickerItem } from '@/lib/types'

/**
 * Everything a manager can DO to messages in the open thread: send (with
 * reply / edit modes), react, soft-delete, forward, copy, stickers and media
 * uploads. All updates are optimistic with rollback on failure — extracted
 * verbatim from inbox-view.tsx.
 *
 * Reply/edit target state lives here because it only feeds these actions and
 * the two composer banners.
 */
export function useMessageActions({
  activeId,
  active,
  currentUser,
  activeAiLed,
  pulseAiButton,
  setLocalMessages,
  startTransition,
}: {
  activeId: string | null
  active: Conversation | null
  currentUser: string
  activeAiLed: boolean
  pulseAiButton: () => void
  setLocalMessages: Dispatch<SetStateAction<Record<string, Message[]>>>
  startTransition: TransitionStartFunction
}) {
  const [replyTarget, setReplyTarget] = useState<Message | null>(null)
  /** Message being edited (own outgoing text only). Mutually exclusive with
   *  replyTarget — starting one cancels the other, Telegram-style. */
  const [editTarget, setEditTarget] = useState<Message | null>(null)

  // Clear any pending reply/edit when switching conversations.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReplyTarget(null)
    setEditTarget(null)
  }, [activeId])

  // Called by the composer with the trimmed text. The composer owns the draft
  // and clears its own input after invoking this.
  function handleSend(text: string) {
    if (!activeId) return
    const body = text.trim()
    if (!body) return
    // While the AI is leading this thread, manual sends are blocked. Nudge the
    // manager to pause the AI first (the AI button vibrates as the hint).
    if (activeAiLed) {
      pulseAiButton()
      toast.error('ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.')
      return
    }
    // Edit mode: overwrite the target message optimistically, send the edit to
    // Telegram, and roll the bubble back if the server rejects it.
    if (editTarget) {
      const target = editTarget
      const prevBody = target.body
      if (body === prevBody.trim()) {
        setEditTarget(null)
        return
      }
      setLocalMessages((prev) => ({
        ...prev,
        [activeId]: (prev[activeId] ?? []).map((m) =>
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
        const res = await editMessageAction(target.id, body)
        if (!res.ok) {
          toast.error(res.message)
          setLocalMessages((prev) => ({
            ...prev,
            [activeId]: (prev[activeId] ?? []).map((m) =>
              m.id === target.id ? { ...m, body: prevBody } : m,
            ),
          }))
        }
      })
      return
    }
    const replyTo = replyTarget
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: activeId,
      direction: 'out',
      body,
      author: currentUser,
      createdAt: new Date().toISOString(),
      status: 'sent',
      ...(replyTo
        ? {
            replyTo: {
              id: replyTo.id,
              author: replyTo.author,
              body: replyTo.body,
              ...(replyTo.mediaType ? { mediaType: replyTo.mediaType } : {}),
            },
          }
        : {}),
    }
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: [...(prev[activeId] ?? []), optimistic],
    }))
    setReplyTarget(null)
    startTransition(async () => {
      const res =
        replyTo && active?.channelType === 'telegram'
          ? await replyMessageAction(activeId, replyTo.id, body)
          : await sendMessageAction(activeId, body)
      if (!res.ok) toast.error(res.message)
    })
  }

  /** Set (or clear) the operator's emoji reaction on a message, optimistically. */
  function reactTo(message: Message, emoji: string) {
    if (!activeId) return
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((m) => {
        if (m.id !== message.id) return m
        const others = (m.reactions ?? []).filter((r) => !r.fromMe)
        const reactions = emoji ? [...others, { emoji, fromMe: true }] : others
        return { ...m, reactions: reactions.length ? reactions : undefined }
      }),
    }))
    startTransition(async () => {
      const res = await reactMessageAction(message.id, emoji)
      if (!res.ok) toast.error(res.message)
    })
  }

  /** Soft-delete a message (revoke in Telegram), optimistically. */
  function deleteMessage(message: Message) {
    if (!activeId) return
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((m) =>
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
      const res = await deleteMessageAction(message.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  /** Forward a message to another Telegram conversation. */
  function forwardMessage(message: Message, toConversationId: string) {
    startTransition(async () => {
      const res = await forwardMessageAction(message.id, toConversationId)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  /** Copy a message's text to the clipboard. */
  function copyMessageText(message: Message) {
    navigator.clipboard
      ?.writeText(message.body)
      .then(() => toast.success('Текст скопирован'))
      .catch(() => toast.error('Не удалось скопировать'))
  }

  function sendSticker(sticker: StickerItem) {
    if (!activeId) return
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: activeId,
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
      [activeId]: [...(prev[activeId] ?? []), optimistic],
    }))
    startTransition(async () => {
      const res = await sendStickerAction(activeId, sticker)
      if (!res.ok) toast.error(res.message)
    })
  }

  /** Schedule a message for later delivery (Telegram only). Server-side
   *  schedule_date: Telegram delivers at the chosen time on its own. No
   *  optimistic bubble — the row appears via the normal revalidate with its
   *  "[Запланировано на …]" preview, avoiding a duplicate when SWR catches up. */
  function scheduleSend(body: string, scheduleAtIso: string) {
    if (!activeId) return
    if (activeAiLed) {
      pulseAiButton()
      toast.error('ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.')
      return
    }
    startTransition(async () => {
      const res = await sendScheduledMessageAction(
        activeId,
        body,
        scheduleAtIso,
      )
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  /** Send a voice note recorded in the composer (Telegram only). Optimistic:
   *  a 'voice' bubble appears immediately; a rejected send flags it failed. */
  function sendVoice(audio: {
    base64: string
    mime: string
    durationSec: number
  }) {
    if (!activeId) return
    if (activeAiLed) {
      pulseAiButton()
      toast.error('ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.')
      return
    }
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: activeId,
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
      [activeId]: [...(prev[activeId] ?? []), optimistic],
    }))
    startTransition(async () => {
      const res = await sendVoiceAction(activeId, audio)
      if (!res.ok) toast.error(res.message)
    })
  }

  // Attach + send a file on a WhatsApp or VK conversation. The bytes are
  // uploaded provider-side (through the account's proxy); on success the realtime
  // insert (or refresh) shows the new message with its media bubble.
  function handleSendMediaFile(file: File, caption: string) {
    if (!activeId) return
    const channelType = active?.channelType
    if (channelType !== 'whatsapp' && channelType !== 'vk') return
    // Client-side guard so an over-large file fails with a clear message instead
    // of blowing past the Server Action body limit (which returns an opaque
    // framework error and would otherwise crash the inbox to the error page).
    // 200 MB matches the app's largest server-side allowance (VK docs).
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
      // Обычный fetch к API-роуту вместо server action: POST экшена с крупным
      // файлом режется прокси-слоями и падает с генерик-ошибкой фреймворка.
      try {
        const resp = await fetch('/api/chat-media/upload', {
          method: 'POST',
          body: fd,
        })
        let res: { ok?: boolean; message?: string } = {}
        try {
          res = (await resp.json()) as typeof res
        } catch {
          /* не-JSON ответ (обрезано прокси) — обработаем по статусу ниже */
        }
        if (resp.ok && res.ok) {
          toast.success(res.message ?? 'Файл отправлен.')
          // No router.refresh(): the sent media message arrives back through
          // the SSE stream and is patched into localMessages there.
        } else {
          toast.error(
            res.message ??
              (resp.status === 413
                ? 'Файл слишком большой для сервера. Уменьшите его или отправьте ссылкой.'
                : 'Не удалось отправить файл. Попробуйте ещё раз.'),
          )
        }
      } catch (err) {
        // Any transport/framework failure (e.g. dropped connection) is
        // contained here as a toast — never bubbled to the error boundary,
        // which would replace the whole inbox with the crash page.
        console.error('[v0] media upload failed:', err)
        toast.error('Сеть прервала загрузку. Проверьте соединение и попробуйте снова.')
      }
    })
  }

  return {
    replyTarget,
    setReplyTarget,
    editTarget,
    setEditTarget,
    handleSend,
    reactTo,
    deleteMessage,
    forwardMessage,
    copyMessageText,
    sendSticker,
    sendVoice,
    scheduleSend,
    handleSendMediaFile,
  }
}
