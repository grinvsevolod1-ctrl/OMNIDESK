'use client'

import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type SetStateAction,
  type TransitionStartFunction,
} from 'react'
import { toast } from 'sonner'
import { reportBatchOutcome, sendMediaBatch } from '@/lib/media-batch-client'
import { newClientMessageId } from '@/lib/client-message-id'
import type { Conversation, Message, StickerItem } from '@/lib/types'
import type { ThreadAdapter, VoiceAudio } from './thread-adapter'

/** Read a File into a bare base64 string (no data: prefix) for job payloads. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

const TG_MAX_BYTES = 15 * 1024 * 1024
/** Matches the app's largest server-side allowance (VK docs). */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024

/**
 * Everything a human operator can DO to messages in the open thread: send
 * (with reply / edit modes), react, soft-delete, forward, copy, stickers,
 * voice, scheduled text, and media uploads. All updates are optimistic with
 * rollback on failure.
 *
 * Shared by the manager and the curator — the role plugs in through
 * `adapter` (which server actions to call) and the optional `canSend` gate
 * (the manager blocks manual sends while the AI leads the thread; the curator
 * has no such gate because a transferred thread is always human-led).
 *
 * Reply/edit target state lives here because it only feeds these actions and
 * the two composer banners. Every returned function is referentially stable
 * for a given `activeId`, so memoised rows and the composer do not re-render
 * on every parent render.
 */
export function useMessageActions({
  adapter,
  activeId,
  active,
  currentUser,
  canSend,
  setLocalMessages,
  startTransition,
}: {
  adapter: ThreadAdapter
  activeId: string | null
  active: Conversation | null
  currentUser: string
  /** Return false to block a manual send (and surface why). Default: allow. */
  canSend?: () => boolean
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

  const channelType = active?.channelType ?? ''

  const handleReply = useCallback((message: Message) => {
    setEditTarget(null)
    setReplyTarget(message)
  }, [])

  const handleEdit = useCallback((message: Message) => {
    setReplyTarget(null)
    setEditTarget(message)
  }, [])

  // Called by the composer with the trimmed text. The composer owns the draft
  // and clears its own input after invoking this.
  const handleSend = useCallback(
    (text: string) => {
      if (!activeId) return
      const body = text.trim()
      if (!body) return
      if (canSend && !canSend()) return
      // Edit mode: overwrite the target message optimistically, send the
      // edit, and roll the bubble back if the server rejects it.
      if (editTarget) {
        const target = editTarget
        const prevBody = target.body ?? ''
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
          const res = await adapter.edit(target.id, body)
          if (!res.ok) {
            toast.error(res.message ?? 'Не удалось изменить сообщение.')
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
      // One idempotency key per send ATTEMPT: the server dedupes on it, so a
      // retried action / double tap reaches the contact exactly once.
      const clientMessageId = newClientMessageId()
      const optimistic: Message = {
        id: `tmp_${clientMessageId}`,
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
                author: replyTo.author ?? '',
                body: replyTo.body ?? '',
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
        const res = await adapter.send(
          activeId,
          body,
          replyTo,
          channelType,
          clientMessageId,
        )
        if (!res.ok) toast.error(res.message ?? 'Не удалось отправить.')
      })
    },
    [
      adapter,
      activeId,
      canSend,
      channelType,
      currentUser,
      editTarget,
      replyTarget,
      setLocalMessages,
      startTransition,
    ],
  )

  /** Set (or clear) the operator's emoji reaction on a message, optimistically. */
  const reactTo = useCallback(
    (message: Message, emoji: string) => {
      if (!activeId) return
      setLocalMessages((prev) => ({
        ...prev,
        [activeId]: (prev[activeId] ?? []).map((m) => {
          if (m.id !== message.id) return m
          const others = (m.reactions ?? []).filter((r) => !r.fromMe)
          const reactions = emoji
            ? [...others, { emoji, fromMe: true }]
            : others
          return { ...m, reactions: reactions.length ? reactions : undefined }
        }),
      }))
      startTransition(async () => {
        const res = await adapter.react(message.id, emoji)
        if (!res.ok) toast.error(res.message ?? 'Не удалось поставить реакцию.')
      })
    },
    [adapter, activeId, setLocalMessages, startTransition],
  )

  /** Soft-delete a message (revoke in Telegram), optimistically. */
  const deleteMessage = useCallback(
    (message: Message) => {
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
        const res = await adapter.remove(message.id)
        if (res.ok) toast.success(res.message ?? 'Сообщение удалено.')
        else toast.error(res.message ?? 'Не удалось удалить сообщение.')
      })
    },
    [adapter, activeId, setLocalMessages, startTransition],
  )

  /** Forward a message to another Telegram conversation. */
  const forwardMessage = useCallback(
    (message: Message, toConversationId: string) => {
      startTransition(async () => {
        const res = await adapter.forward(message.id, toConversationId)
        if (res.ok) toast.success(res.message ?? 'Переслано.')
        else toast.error(res.message ?? 'Не удалось переслать.')
      })
    },
    [adapter, startTransition],
  )

  /** Copy a message's text to the clipboard. */
  const copyMessageText = useCallback((message: Message) => {
    const text = message.body ?? ''
    if (!text) return
    void navigator.clipboard
      ?.writeText(text)
      .then(() => toast.success('Текст скопирован'))
      .catch(() => toast.error('Не удалось скопировать'))
  }, [])

  const sendSticker = useCallback(
    (sticker: StickerItem) => {
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
        const res = await adapter.sendSticker(activeId, sticker)
        if (!res.ok) toast.error(res.message ?? 'Не удалось отправить стикер.')
      })
    },
    [adapter, activeId, currentUser, setLocalMessages, startTransition],
  )

  /** Schedule a message for later delivery (Telegram only). Server-side
   *  schedule_date: Telegram delivers at the chosen time on its own. No
   *  optimistic bubble — the row appears via the normal revalidate with its
   *  "[Запланировано на …]" preview, avoiding a duplicate when SWR catches up. */
  const scheduleSend = useCallback(
    (body: string, scheduleAtIso: string) => {
      if (!activeId) return
      if (canSend && !canSend()) return
      startTransition(async () => {
        const res = await adapter.schedule(activeId, body, scheduleAtIso)
        if (res.ok) toast.success(res.message ?? 'Запланировано.')
        else toast.error(res.message ?? 'Не удалось запланировать.')
      })
    },
    [adapter, activeId, canSend, startTransition],
  )

  /** Send a voice note recorded in the composer (Telegram only). Optimistic:
   *  a 'voice' bubble appears immediately; a rejected send flags it failed. */
  const sendVoice = useCallback(
    (audio: VoiceAudio) => {
      if (!activeId) return
      if (canSend && !canSend()) return
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
        const res = await adapter.sendVoice(activeId, audio)
        if (!res.ok) toast.error(res.message ?? 'Не удалось отправить голосовое.')
      })
    },
    [adapter, activeId, canSend, currentUser, setLocalMessages, startTransition],
  )

  // Attach + send ONE file. Telegram rides the MTProto session via a worker
  // job (base64 payload, tighter ~15 MB cap); WhatsApp/VK upload provider-side
  // through the role-scoped multipart route. On success the realtime insert
  // shows the new message with its media bubble — no router.refresh().
  const handleSendMediaFile = useCallback(
    async (file: File, caption: string) => {
      if (!activeId) return
      if (channelType === 'telegram') {
        if (file.size > TG_MAX_BYTES) {
          toast.error('Файл слишком большой для Telegram (максимум ~15 МБ).')
          return
        }
        try {
          const base64 = await fileToBase64(file)
          const res = await adapter.sendTelegramMedia(
            activeId,
            {
              base64,
              mime: file.type || 'application/octet-stream',
              name: file.name,
            },
            caption,
          )
          if (!res.ok) toast.error(res.message || 'Не удалось отправить файл.')
        } catch (err) {
          console.error('[inbox] telegram media send failed:', err)
          toast.error('Не удалось отправить файл. Попробуйте ещё раз.')
        }
        return
      }
      if (channelType !== 'whatsapp' && channelType !== 'vk') return
      // Client-side guard so an over-large file fails with a clear message
      // instead of blowing past the body limit (opaque framework error that
      // would otherwise crash the inbox to the error page).
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
        // Plain fetch to an API route instead of a server action: a large
        // action POST gets cut by proxy layers and fails with a generic error.
        try {
          const resp = await fetch(adapter.uploadRoute, {
            method: 'POST',
            body: fd,
          })
          let res: { ok?: boolean; message?: string } = {}
          try {
            res = (await resp.json()) as typeof res
          } catch {
            /* non-JSON (truncated by a proxy) — fall through to status below */
          }
          if (resp.ok && res.ok) {
            toast.success(res.message ?? 'Файл отправлен.')
          } else {
            toast.error(
              res.message ??
                (resp.status === 413
                  ? 'Файл слишком большой для сервера. Уменьшите его или отправьте ссылкой.'
                  : 'Не удалось отправить файл. Попробуйте ещё раз.'),
            )
          }
        } catch (err) {
          // Any transport failure stays a toast — never bubbled to the error
          // boundary, which would replace the whole inbox with the crash page.
          console.error('[inbox] media upload failed:', err)
          toast.error(
            'Сеть прервала загрузку. Проверьте соединение и попробуйте снова.',
          )
        }
      })
    },
    [adapter, activeId, channelType, startTransition],
  )

  // Bulk send: the whole staged tray in chunked server-side batches. One
  // request per ~20 files instead of one per file, progress reported to the
  // composer's tray. The batch route reads the role from the session.
  const handleSendMediaBatch = useCallback(
    async (
      files: File[],
      caption: string,
      onProgress: (p: { sent: number; total: number }) => void,
    ) => {
      if (!activeId) return
      if (
        channelType !== 'telegram' &&
        channelType !== 'whatsapp' &&
        channelType !== 'vk'
      ) {
        toast.error('Вложения недоступны для этого канала.')
        return
      }
      const outcome = await sendMediaBatch({
        conversationId: activeId,
        channel: channelType,
        files,
        caption,
        onProgress,
      })
      reportBatchOutcome(outcome)
    },
    [activeId, channelType],
  )

  return {
    replyTarget,
    setReplyTarget,
    editTarget,
    setEditTarget,
    handleReply,
    handleEdit,
    handleSend,
    reactTo,
    deleteMessage,
    forwardMessage,
    copyMessageText,
    sendSticker,
    sendVoice,
    scheduleSend,
    handleSendMediaFile,
    handleSendMediaBatch,
  }
}
