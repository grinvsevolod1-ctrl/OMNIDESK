'use client'

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react'
import { toast } from 'sonner'
import {
  secretEditMessageAction,
  secretMessengerDeleteMessageAction,
  secretSendMediaMessageAction,
  secretSendMessageAction,
  type ConversationWithManager,
} from '@/app/actions/admin-secret'
import type { MediaType, Message } from '@/lib/types'
import { parseReply, snippetOf } from './reply'
import { useMediaStaging } from '@/components/manager/inbox/media-staging'

/**
 * Composer logic of the god messenger: draft / reply / edit state, send-as-
 * the-client (optimistic append), attachments, voice-note recording and the
 * long-press action sheet dispatch. Extracted verbatim from god-messenger.tsx.
 */
export function useGodComposer({
  selectedIdRef,
  conversation,
  setMessages,
  loadList,
  pinOnNextGrowth,
}: {
  selectedIdRef: MutableRefObject<string | null>
  conversation: ConversationWithManager | null
  setMessages: Dispatch<SetStateAction<Message[]>>
  loadList: (opts?: { silent?: boolean }) => Promise<void>
  pinOnNextGrowth: () => void
}) {
  // Uncontrolled draft: the textarea owns its value in the DOM, mirrored here in
  // `valueRef`. Typing therefore triggers NO React re-render of the messenger —
  // a controlled `value` re-rendered the whole god messenger (list + thread) on
  // every keystroke, so characters painted late (the reported lag). The only
  // React state driven by typing is `hasDraft`, flipped once when crossing
  // empty↔non-empty (send button enable + mic⇄send swap).
  const valueRef = useRef('')
  const [hasDraft, setHasDraft] = useState(false)
  const [replyTo, setReplyTo] = useState<Message | null>(null)
  const [editing, setEditing] = useState<Message | null>(null)
  const [menuFor, setMenuFor] = useState<Message | null>(null)
  const [uploading, setUploading] = useState(false)
  const [pending, startTransition] = useTransition()

  // Voice note recording (MediaRecorder).
  const [recording, setRecording] = useState(false)
  const [recordSecs, setRecordSecs] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const recordChunks = useRef<Blob[]>([])
  const recordTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  const recordCancelled = useRef(false)

  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  // `sendMessage` (defined before the staging hook) reaches the tray + batch
  // sender through refs to avoid a declaration-order cycle with `uploadFile`.
  const mediaRef = useRef<{ count: number }>({ count: 0 })
  const sendStagedRef = useRef<() => void>(() => {})

  const resizeComposer = useCallback(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  // Programmatic value changes (emoji, edit prefill, clear-after-send, error
  // restore). Writes straight to the uncontrolled textarea, mirrors `valueRef`,
  // flips `hasDraft` only on an empty↔non-empty transition, and resizes.
  // `focusEnd` focuses and drops the caret at the end.
  const applyValue = useCallback(
    (next: string, focusEnd = false) => {
      valueRef.current = next
      const el = composerRef.current
      if (el) {
        el.value = next
        if (focusEnd) {
          el.focus()
          const end = next.length
          el.setSelectionRange(end, end)
        }
      }
      setHasDraft((prev) => {
        const now = Boolean(next.trim())
        return prev === now ? prev : now
      })
      resizeComposer()
    },
    [resizeComposer],
  )

  // Typing hot path: mirror the DOM value into `valueRef` and flip `hasDraft`
  // only on an empty↔non-empty transition (the updater bails out otherwise, so
  // ordinary keystrokes cause no re-render at all).
  const markDraft = useCallback((next: string) => {
    valueRef.current = next
    setHasDraft((prev) => {
      const now = Boolean(next.trim())
      return prev === now ? prev : now
    })
  }, [])

  /** Called by the parent when the selected thread changes. */
  const resetForNewThread = useCallback(() => {
    setReplyTo(null)
    setEditing(null)
    setMenuFor(null)
  }, [])

  /* ----- reply / edit ----- */
  const startReply = useCallback((message: Message) => {
    if (message.deletedAt) return
    setEditing(null)
    setReplyTo(message)
    composerRef.current?.focus()
  }, [])

  const startEdit = useCallback(
    (message: Message) => {
      setReplyTo(null)
      setEditing(message)
      applyValue(parseReply(message.body).text, true)
    },
    [applyValue],
  )

  const cancelComposeExtras = useCallback(() => {
    setReplyTo(null)
    if (editing) applyValue('')
    setEditing(null)
  }, [editing, applyValue])

  /* ----- message action sheet ----- */
  const menuAction = useCallback(
    (action: 'reply' | 'copy' | 'edit' | 'delete') => {
      const msg = menuFor
      setMenuFor(null)
      if (!msg) return
      switch (action) {
        case 'reply':
          startReply(msg)
          break
        case 'copy': {
          const text = parseReply(msg.body).text
          void navigator.clipboard
            ?.writeText(text)
            .then(() => toast.success('Скопировано'))
            .catch(() => toast.error('Не удалось скопировать'))
          break
        }
        case 'edit':
          startEdit(msg)
          break
        case 'delete':
          startTransition(async () => {
            const res = await secretMessengerDeleteMessageAction({
              messageId: msg.id,
              conversationId: msg.conversationId,
            })
            if (res.ok) {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === msg.id
                    ? { ...m, deletedAt: new Date().toISOString(), deletedOrigin: 'remote' as const }
                    : m,
                ),
              )
              void loadList({ silent: true })
            } else {
              toast.error(res.message)
            }
          })
          break
      }
    },
    [menuFor, startReply, startEdit, loadList, setMessages],
  )

  /* ----- send / save edit (as the client) ----- */
  const sendMessage = useCallback(() => {
    // Staged files take priority: the textarea draft becomes the group caption.
    if (mediaRef.current.count > 0) {
      sendStagedRef.current()
      return
    }
    const text = valueRef.current.trim()
    if (!text || !selectedIdRef.current) return
    const convId = selectedIdRef.current

    if (editing) {
      const target = editing
      applyValue('')
      setEditing(null)
      startTransition(async () => {
        const res = await secretEditMessageAction({
          messageId: target.id,
          conversationId: convId,
          body: text,
        })
        if (res.ok) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === target.id
                ? {
                    ...m,
                    body: text,
                    editedAt: new Date().toISOString(),
                    editCount: (m.editCount ?? 0) + 1,
                  }
                : m,
            ),
          )
          void loadList({ silent: true })
        } else {
          toast.error(res.message)
          // Restore edit state only if the user hasn't started typing anew.
          if (!valueRef.current.trim()) applyValue(text)
          setEditing((cur) => cur ?? target)
        }
      })
      return
    }

    const target = replyTo
    applyValue('')
    setReplyTo(null)
    pinOnNextGrowth()
    startTransition(async () => {
      const res = await secretSendMessageAction({
        conversationId: convId,
        body: text,
        direction: 'in',
        replyToMessageId: target?.id,
      })
      if (res.ok && res.id) {
        // Optimistic local append — no full-thread refetch. The SSE echo of
        // this same message is deduped by id.
        const newMsg: Message = {
          id: res.id,
          conversationId: convId,
          direction: 'in',
          body: text,
          author: conversation?.contactName || 'Клиент',
          createdAt: res.createdAt ?? new Date().toISOString(),
          ...(target
            ? {
                replyTo: {
                  id: target.id,
                  author:
                    target.direction === 'in'
                      ? conversation?.contactName || 'Клиент'
                      : 'Менеджер',
                  body: snippetOf(target),
                  ...(target.mediaType ? { mediaType: target.mediaType } : {}),
                },
              }
            : {}),
        }
        setMessages((prev) =>
          prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg],
        )
        void loadList({ silent: true })
      } else if (!res.ok) {
        toast.error(res.message)
        // Don't clobber text the user typed while the request was in flight.
        if (!valueRef.current.trim()) applyValue(text)
        setReplyTo((cur) => cur ?? target)
      }
    })
  }, [replyTo, editing, conversation, loadList, pinOnNextGrowth, selectedIdRef, setMessages, applyValue])

  /* ----- attachments ----- */
  // `captionOverride` lets the batch sender pass an explicit caption (empty for
  // all-but-first file) instead of consuming the live textarea draft. When it is
  // undefined the single-file path keeps its original behaviour (take + clear
  // the current draft).
  const uploadFile = useCallback(
    (file: File, kind?: 'voice', captionOverride?: string) => {
      const convId = selectedIdRef.current
      if (!convId) return
      const fd = new FormData()
      fd.set('file', file)
      fd.set('conversationId', convId)
      fd.set('direction', 'in')
      if (kind) fd.set('kind', kind)
      const caption = kind
        ? ''
        : captionOverride !== undefined
          ? captionOverride.trim()
          : valueRef.current.trim()
      if (caption) {
        fd.set('caption', caption)
        if (captionOverride === undefined) applyValue('')
      }

      const mediaType: MediaType =
        kind === 'voice'
          ? 'voice'
          : file.type.startsWith('image/')
            ? 'image'
            : file.type.startsWith('video/')
              ? 'video'
              : file.type.startsWith('audio/')
                ? 'audio'
                : 'document'
      // Optimistic bubble: show the file in the thread IMMEDIATELY from a local
      // object URL with an "uploading" overlay (Telegram-style), then reconcile
      // with the server row on success. The local URL keeps the preview instant
      // for this session; a reload fetches the durable copy from /api/media.
      const tempId = `tmp-${crypto.randomUUID()}`
      const localUrl =
        mediaType === 'image' || mediaType === 'video'
          ? URL.createObjectURL(file)
          : undefined
      const optimistic: Message = {
        id: tempId,
        conversationId: convId,
        direction: 'in',
        body: caption,
        author: conversation?.contactName || 'Клиент',
        createdAt: new Date().toISOString(),
        status: 'pending',
        mediaType,
        mediaMime: file.type || undefined,
        mediaName: file.name || undefined,
        mediaUrl: localUrl,
      }
      setMessages((prev) => [...prev, optimistic])

      setUploading(true)
      pinOnNextGrowth()
      // Fetch-роут вместо server action: POST экшена с крупным файлом режется
      // прокси-слоями и падает с генерик-ошибкой фреймворка.
      void fetch('/wijegniwjgwjog/api/upload', { method: 'POST', body: fd })
        .then(async (resp) => {
          try {
            return (await resp.json()) as Awaited<
              ReturnType<typeof secretSendMediaMessageAction>
            >
          } catch {
            return {
              ok: false as const,
              message:
                resp.status === 413
                  ? 'Файл слишком большой для сервера.'
                  : 'Не удалось отправить файл.',
            }
          }
        })
        .then((res) => {
          if (res.ok && res.id) {
            const realId = res.id
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? {
                      ...optimistic,
                      id: realId,
                      createdAt: res.createdAt ?? optimistic.createdAt,
                      status: undefined,
                      mediaUrl: localUrl ?? `/api/media/${realId}`,
                    }
                  : m,
              ),
            )
            void loadList({ silent: true })
          } else if (!res.ok) {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === tempId
                  ? { ...m, status: 'failed', errorReason: res.message }
                  : m,
              ),
            )
            toast.error(res.message)
          }
        })
        .catch(() => {
          setMessages((prev) =>
            prev.map((m) => (m.id === tempId ? { ...m, status: 'failed' } : m)),
          )
          toast.error('Не удалось отправить файл')
        })
        .finally(() => setUploading(false))
    },
    [applyValue, conversation, loadList, pinOnNextGrowth, selectedIdRef, setMessages],
  )

  // Telegram-style multi-file staging: picked/dropped files land in the tray,
  // then send as a batch with the textarea draft as the group caption (first
  // file carries it). Single-file selection still works — the tray simply holds
  // one item.
  const media = useMediaStaging()

  const onFilePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files
      e.target.value = ''
      if (files && files.length) media.addFiles(files)
    },
    [media],
  )

  const sendStagedFiles = useCallback(() => {
    const staged = media.files
    if (staged.length === 0) return
    const caption = valueRef.current.trim()
    media.clear()
    applyValue('')
    staged.forEach((s, i) => uploadFile(s.file, undefined, i === 0 ? caption : ''))
  }, [media, uploadFile, applyValue])

  // Keep the refs read by `sendMessage` pointing at the live tray + sender.
  mediaRef.current = { count: media.count }
  sendStagedRef.current = sendStagedFiles

  /* ----- voice notes ----- */
  const stopRecordTimer = () => {
    if (recordTimer.current) clearInterval(recordTimer.current)
    recordTimer.current = null
  }

  const startRecording = useCallback(async () => {
    if (recording) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : ''
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      recordChunks.current = []
      recordCancelled.current = false
      rec.ondataavailable = (ev) => {
        if (ev.data.size > 0) recordChunks.current.push(ev.data)
      }
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop())
        stopRecordTimer()
        setRecording(false)
        setRecordSecs(0)
        if (recordCancelled.current || recordChunks.current.length === 0) return
        const type = rec.mimeType || 'audio/webm'
        const ext = type.includes('mp4') ? 'm4a' : 'webm'
        const blob = new Blob(recordChunks.current, { type })
        if (blob.size === 0) return
        uploadFile(new File([blob], `voice.${ext}`, { type }), 'voice')
      }
      recorderRef.current = rec
      rec.start(250)
      setRecording(true)
      setRecordSecs(0)
      recordTimer.current = setInterval(
        () => setRecordSecs((s) => s + 1),
        1000,
      )
    } catch {
      toast.error('Нет доступа к микрофону')
    }
  }, [recording, uploadFile])

  const finishRecording = useCallback((cancel: boolean) => {
    recordCancelled.current = cancel
    const rec = recorderRef.current
    recorderRef.current = null
    if (rec && rec.state !== 'inactive') rec.stop()
  }, [])

  // Never leave the mic open on unmount.
  useEffect(
    () => () => {
      recordCancelled.current = true
      const rec = recorderRef.current
      if (rec && rec.state !== 'inactive') rec.stop()
      stopRecordTimer()
    },
    [],
  )

  return {
    valueRef,
    applyValue,
    markDraft,
    hasDraft,
    replyTo,
    editing,
    menuFor,
    setMenuFor,
    uploading,
    pending,
    recording,
    recordSecs,
    composerRef,
    fileInputRef,
    resetForNewThread,
    startReply,
    startEdit,
    cancelComposeExtras,
    menuAction,
    sendMessage,
    onFilePicked,
    startRecording,
    finishRecording,
    media,
    sendStagedFiles,
  }
}
