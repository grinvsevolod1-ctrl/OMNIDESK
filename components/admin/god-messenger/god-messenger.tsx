'use client'

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Check,
  ChevronLeft,
  Copy,
  CornerUpLeft,
  Loader2,
  Mic,
  Paperclip,
  Pencil,
  Plus,
  Radio,
  Search,
  Send,
  Trash2,
  X,
  MessagesSquare,
} from 'lucide-react'
import {
  secretEditMessageAction,
  secretFetchThreadAction,
  secretListConversationsAction,
  secretMarkThreadReadAction,
  secretMessengerDeleteMessageAction,
  secretSendMediaMessageAction,
  secretSendMessageAction,
  type ConversationWithManager,
} from '@/app/actions/admin-secret'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Channel, Manager, MediaType, Message } from '@/lib/types'
import { TYPE_LABEL, fmtTime, initials, isComposing } from './utils'
import { NewChatDialog } from './new-chat-dialog'
import { NotifyButton } from './notify-button'
import { MessageBubble } from './message-bubble'
import { parseReply, snippetOf } from './reply'
import { EmojiPicker } from './emoji-picker'

/**
 * God messenger root. A phone-first, full-screen chat surface where the god
 * "is" the client: MY messages (direction 'in') sit on the right, the manager's
 * replies (direction 'out') on the left — the mirror image of the manager inbox.
 * Reuses the god-console server actions + the admin SSE stream, so everything is
 * live and lands in the real manager inbox.
 *
 * Telegram-parity features: real quoted replies, edit/delete own messages,
 * emoji palette, file/photo/video attachments, voice notes, optimistic sends,
 * SSE reconnect resync, smart autoscroll and a long-press action sheet.
 */
export function GodMessenger({
  channels,
  managers,
  pushAvailable,
}: {
  channels: Channel[]
  managers: Manager[]
  pushAvailable: boolean
}) {
  const searchParams = useSearchParams()
  const deepLinkId = searchParams.get('c')

  const [conversations, setConversations] = useState<ConversationWithManager[]>([])
  const [loadingList, setLoadingList] = useState(true)
  const [search, setSearch] = useState('')

  const [selectedId, setSelectedId] = useState<string | null>(deepLinkId)
  const [conversation, setConversation] = useState<ConversationWithManager | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  // Render window: only the newest N messages hit the DOM. Long chats
  // (hundreds of messages) otherwise make opening a thread visibly slow on
  // mobile. "Показать ещё" expands the window; SSE appends work unchanged.
  const [visibleCount, setVisibleCount] = useState(MESSAGES_WINDOW)
  const [loadingThread, setLoadingThread] = useState(false)

  const [live, setLive] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [draft, setDraft] = useState('')
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

  // Swipe-back: drag RIGHT anywhere in the thread (mobile, touch only) to
  // return to the chat list — like Telegram/iOS. Doesn't clash with
  // swipe-to-reply on bubbles because that gesture only claims LEFTWARD drags.
  const [backDrag, setBackDrag] = useState(0)
  const backStart = useRef<{ x: number; y: number } | null>(null)
  const backAxis = useRef<null | 'h' | 'v'>(null)

  const selectedIdRef = useRef<string | null>(selectedId)
  useEffect(() => {
    selectedIdRef.current = selectedId
  }, [selectedId])

  const listRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  const threadRefetch = useRef<ReturnType<typeof setTimeout> | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)
  const scrollBoxRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)
  // True while a freshly opened thread hasn't been positioned yet — the first
  // messages render must JUMP to the bottom instantly (no smooth animation
  // crawling down from the top of the history).
  const initialJumpPending = useRef(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const initialListLoaded = useRef(false)
  const hadConnected = useRef(false)

  const managerNameOf = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string | null) => (id ? map.get(id) ?? '—' : '—')
  }, [managers])

  /* ----- selection ⇄ URL sync -----
   * The open thread id lives in ?c=. If ANYTHING remounts this component
   * (router refresh, HMR, tab restore), the open dialog is restored instead of
   * kicking the user back to the chat list mid-conversation. replaceState only
   * — no navigation, no RSC round-trip. */
  const selectThread = useCallback((id: string | null) => {
    setSelectedId(id)
    try {
      const url = new URL(window.location.href)
      if (id) url.searchParams.set('c', id)
      else url.searchParams.delete('c')
      window.history.replaceState(null, '', url.toString())
    } catch {
      /* URL sync is best-effort */
    }
  }, [])

  /* ----- list loading -----
   * Resilient by design. Server actions fail transiently ALL the time on
   * mobile (phone sleeping, network switching, dev-server recompiles) and the
   * old code turned every single hiccup into an error toast — even for
   * background refetches where perfectly good data was already on screen.
   *
   * Policy:
   *  - every load retries up to 3 times with exponential backoff (0.5s/1.5s/3s)
   *  - background (silent) failures NEVER toast: stale data stays visible and
   *    the next SSE tick / resync retries anyway
   *  - only a failed INITIAL load (nothing on screen yet) surfaces an error,
   *    with a retry button so the user isn't stuck staring at a dead screen */
  const listSeq = useRef(0)
  // Stable self-references for the toast retry buttons (a useCallback can't
  // legally reference itself before declaration).
  const loadListRef = useRef<(opts?: { silent?: boolean }) => void>(() => {})
  const loadThreadRef = useRef<(id: string, opts?: { silent?: boolean }) => void>(
    () => {},
  )
  const loadList = useCallback(
    async (opts?: { silent?: boolean }) => {
      const seq = ++listSeq.current
      if (!opts?.silent && !initialListLoaded.current) setLoadingList(true)
      let lastError: unknown = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)))
          // A newer load superseded this one while we were backing off.
          if (listSeq.current !== seq) return
        }
        try {
          const rows = await secretListConversationsAction({
            search,
            channelType: 'all',
          })
          if (listSeq.current !== seq) return
          setConversations(rows)
          initialListLoaded.current = true
          setLoadingList(false)
          return
        } catch (err) {
          lastError = err
        }
      }
      if (listSeq.current !== seq) return
      setLoadingList(false)
      console.error('[messenger] list load failed after retries:', lastError)
      // Data already on screen → fail silently, background refresh will win.
      if (initialListLoaded.current || opts?.silent) return
      toast.error('Не удалось загрузить диалоги', {
        action: { label: 'Повторить', onClick: () => loadListRef.current() },
        duration: 8000,
      })
    },
    [search],
  )
  useEffect(() => {
    loadListRef.current = (opts) => void loadList(opts)
  }, [loadList])

  // Initial load fires immediately; subsequent search keystrokes are debounced
  // and SILENT (the previous list stays on screen — no spinner flash per key).
  useEffect(() => {
    if (!initialListLoaded.current) {
      void loadList()
      return
    }
    const id = setTimeout(() => void loadList({ silent: true }), 300)
    return () => clearTimeout(id)
  }, [loadList])

  /* ----- thread loading -----
   * Same resilience policy as the list: retry with backoff, never toast for a
   * background refresh (messages already on screen), retry button otherwise. */
  const loadThread = useCallback(
    async (id: string, opts?: { silent?: boolean }) => {
      if (!opts?.silent) setLoadingThread(true)
      let lastError: unknown = null
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, 500 * 3 ** (attempt - 1)))
          // The user switched threads while we were backing off — abandon.
          if (selectedIdRef.current !== id) return
        }
        try {
          const res = await secretFetchThreadAction(id)
          // Race guard: the user may have switched threads while loading.
          if (selectedIdRef.current !== id) return
          if (res.ok) {
            setConversation(res.conversation)
            setMessages(res.messages)
          } else {
            // Business-level "not found" — retrying won't change the answer.
            toast.error(res.message ?? 'Диалог недоступен')
          }
          setLoadingThread(false)
          return
        } catch (err) {
          lastError = err
        }
      }
      if (selectedIdRef.current !== id) return
      setLoadingThread(false)
      console.error('[messenger] thread load failed after retries:', lastError)
      // Messages already on screen (silent refresh) → keep them, no toast.
      if (opts?.silent) return
      toast.error('Не удалось загрузить переписку', {
        action: { label: 'Повторить', onClick: () => loadThreadRef.current(id) },
        duration: 8000,
      })
    },
    [],
  )
  useEffect(() => {
    loadThreadRef.current = (id, opts) => void loadThread(id, opts)
  }, [loadThread])

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setReplyTo(null)
    setEditing(null)
    setMenuFor(null)
    setVisibleCount(MESSAGES_WINDOW)
    stickToBottom.current = true
    initialJumpPending.current = true
    if (selectedId) void loadThread(selectedId)
    else {
      setConversation(null)
      setMessages([])
    }
  }, [selectedId, loadThread])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* ----- network / tab-visibility resync -----
   * The most common real failure mode on the phone: the tab goes to
   * background, the OS drops the connection, the user comes back and the
   * screen is stale (or the next refetch fails and used to toast an error).
   * Instead: the moment the browser reports we're back online — or the tab
   * becomes visible again — silently resync everything. */
  useEffect(() => {
    const resync = () => {
      void loadList({ silent: true })
      const id = selectedIdRef.current
      if (id) void loadThread(id, { silent: true })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') resync()
    }
    window.addEventListener('online', resync)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.removeEventListener('online', resync)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [loadList, loadThread])

  /* ----- live updates via admin SSE ----- */
  useEffect(() => {
    const es = new EventSource('/api/wijegniwjgwjog/stream')

    es.addEventListener('ready', () => {
      setLive(true)
      // RECONNECT resync: any message that arrived while the stream was down
      // would otherwise be silently missing until the user re-opened the
      // thread. On every reconnect (not the first connect) refetch both the
      // open thread and the list, silently.
      if (hadConnected.current) {
        const id = selectedIdRef.current
        if (id) void loadThread(id, { silent: true })
        void loadList({ silent: true })
      }
      hadConnected.current = true
    })
    es.onerror = () => setLive(false)

    es.addEventListener('update', (ev) => {
      let data: {
        type?: string
        event?: string
        conversationId?: string
        id?: string
        direction?: 'in' | 'out'
        body?: string
        author?: string
        createdAt?: string
      }
      try {
        data = JSON.parse((ev as MessageEvent).data)
      } catch {
        return
      }

      const forSelected =
        Boolean(data.conversationId) &&
        data.conversationId === selectedIdRef.current

      if (data.type === 'message' && forSelected) {
        if (data.event !== 'update' && data.id) {
          // New message in the open thread → append (dedup by id: our own
          // optimistic sends arrive here a second time).
          setMessages((prev) => {
            if (prev.some((m) => m.id === data.id)) return prev
            return [
              ...prev,
              {
                id: data.id as string,
                conversationId: data.conversationId as string,
                direction: (data.direction ?? 'out') as 'in' | 'out',
                body: data.body ?? '',
                author: data.author ?? '',
                createdAt: data.createdAt ?? new Date().toISOString(),
              },
            ]
          })
          // A manager reply landed while this thread is open on screen — the
          // user is reading it right now, so stamp the god-side read receipt
          // before the debounced list refetch computes the unread badge.
          if (data.direction === 'out') {
            void secretMarkThreadReadAction(data.conversationId as string)
          }
        } else {
          // A message changed IN PLACE (edited / deleted / reaction). The SSE
          // payload doesn't carry the full new state, so refetch the thread
          // silently (debounced — bursts collapse to one request).
          if (threadRefetch.current) clearTimeout(threadRefetch.current)
          threadRefetch.current = setTimeout(() => {
            const id = selectedIdRef.current
            if (id) void loadThread(id, { silent: true })
          }, 300)
        }
      }

      if (data.type === 'message' || data.type === 'conversation') {
        if (listRefetch.current) clearTimeout(listRefetch.current)
        listRefetch.current = setTimeout(() => void loadList({ silent: true }), 400)
      }
    })

    return () => {
      es.close()
      if (listRefetch.current) clearTimeout(listRefetch.current)
      if (threadRefetch.current) clearTimeout(threadRefetch.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ----- smart auto-scroll -----
   * Follow new messages ONLY while the user is already at (or near) the
   * bottom. If they scrolled up to read history, an incoming SSE message must
   * not yank them back down (classic Telegram behaviour). */
  const onScrollBox = useCallback(() => {
    const el = scrollBoxRef.current
    if (!el) return
    stickToBottom.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  const pinToBottom = useCallback(() => {
    const el = scrollBoxRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  useEffect(() => {
    if (messages.length === 0) return
    if (initialJumpPending.current) {
      // First render of a freshly opened thread: land on the newest messages
      // INSTANTLY. Double rAF waits out the initial layout so scrollHeight is
      // real (a single sync scroll can land mid-history before bubbles size).
      initialJumpPending.current = false
      pinToBottom()
      requestAnimationFrame(() => {
        pinToBottom()
        requestAnimationFrame(pinToBottom)
      })
      return
    }
    if (stickToBottom.current) {
      endRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages, pinToBottom])

  // Keep the bottom pinned as bubbles grow AFTER the initial jump — images,
  // videos and voice players finish loading asynchronously and would otherwise
  // push the newest messages back out of view (the "opens scrolled up" bug).
  useEffect(() => {
    const container = scrollBoxRef.current
    const content = container?.firstElementChild
    if (!content) return
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) pinToBottom()
    })
    ro.observe(content)
    return () => ro.disconnect()
  }, [selectedId, pinToBottom])

  /* ----- reply / edit ----- */
  const startReply = useCallback((message: Message) => {
    if (message.deletedAt) return
    setEditing(null)
    setReplyTo(message)
    composerRef.current?.focus()
  }, [])

  const startEdit = useCallback((message: Message) => {
    setReplyTo(null)
    setEditing(message)
    setDraft(parseReply(message.body).text)
    composerRef.current?.focus()
  }, [])

  const cancelComposeExtras = useCallback(() => {
    setReplyTo(null)
    if (editing) setDraft('')
    setEditing(null)
  }, [editing])

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
    [menuFor, startReply, startEdit, loadList],
  )

  /* ----- swipe right anywhere in the thread → back to list ----- */
  const onBackPointerDown = useCallback((e: React.PointerEvent) => {
    // Touch only: a mouse drag on desktop must never slide the panel. Also
    // skip on md+ layouts where the list is already visible beside the thread,
    // and NEVER claim gestures that start on interactive controls (composer,
    // buttons, media players) — that's how typing could "kick" the user back.
    if (e.pointerType !== 'touch') return
    if (window.matchMedia('(min-width: 768px)').matches) return
    const target = e.target as HTMLElement | null
    if (target?.closest('textarea, input, button, a, audio, video, [data-no-swipe]'))
      return
    backStart.current = { x: e.clientX, y: e.clientY }
    backAxis.current = null
  }, [])

  const onBackPointerMove = useCallback((e: React.PointerEvent) => {
    if (!backStart.current) return
    const dx = e.clientX - backStart.current.x
    const dy = Math.abs(e.clientY - backStart.current.y)
    // Lock the axis once, exactly like the bubble gesture: a mostly-vertical
    // move is a scroll (give up), a mostly-horizontal RIGHTWARD move is ours.
    if (backAxis.current === null) {
      if (dx > 8 && dx > dy) backAxis.current = 'h'
      else if (dy > 8 || dx < -8) backAxis.current = 'v'
    }
    if (backAxis.current === 'h') {
      setBackDrag(Math.min(Math.max(dx, 0), THREAD_DRAG_MAX))
    }
  }, [])

  const onBackPointerEnd = useCallback(() => {
    if (!backStart.current) return
    backStart.current = null
    backAxis.current = null
    setBackDrag((d) => {
      if (d >= THREAD_DRAG_TRIGGER) selectThread(null)
      return 0
    })
  }, [selectThread])

  /* ----- send / save edit (as the client) ----- */
  const sendMessage = useCallback(() => {
    const text = draft.trim()
    if (!text || !selectedIdRef.current) return
    const convId = selectedIdRef.current

    if (editing) {
      const target = editing
      setDraft('')
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
          setDraft((cur) => cur || text)
          setEditing((cur) => cur ?? target)
        }
      })
      return
    }

    const target = replyTo
    setDraft('')
    setReplyTo(null)
    stickToBottom.current = true
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
        setDraft((cur) => cur || text)
        setReplyTo((cur) => cur ?? target)
      }
    })
  }, [draft, replyTo, editing, conversation, loadList])

  /* ----- attachments ----- */
  const uploadFile = useCallback(
    (file: File, kind?: 'voice') => {
      const convId = selectedIdRef.current
      if (!convId) return
      const fd = new FormData()
      fd.set('file', file)
      fd.set('conversationId', convId)
      fd.set('direction', 'in')
      if (kind) fd.set('kind', kind)
      const caption = kind ? '' : draft.trim()
      if (caption) {
        fd.set('caption', caption)
        setDraft('')
      }
      setUploading(true)
      stickToBottom.current = true
      void secretSendMediaMessageAction(fd)
        .then((res) => {
          if (res.ok && res.id) {
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
            const newMsg: Message = {
              id: res.id,
              conversationId: convId,
              direction: 'in',
              body: caption,
              author: conversation?.contactName || 'Клиент',
              createdAt: res.createdAt ?? new Date().toISOString(),
              mediaType,
              mediaMime: file.type || undefined,
              mediaName: file.name || undefined,
              mediaUrl: `/api/media/${res.id}`,
            }
            setMessages((prev) =>
              prev.some((m) => m.id === newMsg.id) ? prev : [...prev, newMsg],
            )
            void loadList({ silent: true })
          } else if (!res.ok) {
            toast.error(res.message)
          }
        })
        .catch(() => toast.error('Не удалось отправить файл'))
        .finally(() => setUploading(false))
    },
    [draft, conversation, loadList],
  )

  const onFilePicked = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      e.target.value = ''
      if (file) uploadFile(file)
    },
    [uploadFile],
  )

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

  const showThread = selectedId !== null

  const replyLabel = replyTo
    ? replyTo.direction === 'in'
      ? 'Вы'
      : managerNameOf(conversation?.managerId ?? null)
    : ''

  return (
    <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
      <div className="flex min-h-0 flex-1">
        {/* ------------------------- Chat list ------------------------- */}
        <aside
          className={cn(
            'flex w-full shrink-0 flex-col border-r border-border md:w-80 lg:w-96',
            showThread ? 'hidden md:flex' : 'flex',
          )}
        >
          <header className="border-b border-border bg-card/40 px-3 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
            <Link
              href="/wijegniwjgwjog"
              className="mb-2.5 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronLeft className="size-4" />
              К панели
            </Link>
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2.5">
                <div
                  className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary"
                  aria-hidden="true"
                >
                  <MessagesSquare className="size-5" />
                </div>
                <div>
                  <h1 className="text-base font-semibold leading-none tracking-tight">
                    Мессенджер
                  </h1>
                  <span
                    className={cn(
                      'mt-1.5 inline-flex items-center gap-1 text-xs',
                      live ? 'text-success' : 'text-muted-foreground',
                    )}
                  >
                    <Radio className={cn('size-3', live && 'animate-pulse')} />
                    {live ? 'В сети' : 'Подключение…'}
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1">
                <NotifyButton available={pushAvailable} />
                <Button
                  size="icon"
                  className="size-10 rounded-xl"
                  onClick={() => setCreateOpen(true)}
                  aria-label="Новый диалог"
                >
                  <Plus className="size-5" />
                </Button>
              </div>
            </div>
          </header>

          <div className="border-b border-border p-3">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск диалога"
                className="h-11 rounded-xl pl-9 text-base md:text-sm"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {loadingList ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="size-5 animate-spin" />
              </div>
            ) : conversations.length === 0 ? (
              <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
                <MessagesSquare className="size-10 text-muted-foreground/50" />
                <p className="text-sm text-muted-foreground">
                  Диалогов нет. Создайте новый, чтобы начать переписку.
                </p>
                <Button size="sm" className="gap-1.5" onClick={() => setCreateOpen(true)}>
                  <Plus className="size-4" /> Новый диалог
                </Button>
              </div>
            ) : (
              <ul className="space-y-0.5 p-2">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      onClick={() => selectThread(c.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-muted/60 active:bg-muted',
                        c.id === selectedId
                          ? 'bg-primary/10 ring-1 ring-inset ring-primary/20'
                          : 'bg-transparent',
                      )}
                    >
                      <Avatar
                        className={cn(
                          'size-12 shrink-0',
                          (c.godUnread ?? 0) > 0 &&
                            'ring-2 ring-primary ring-offset-2 ring-offset-background',
                        )}
                      >
                        <AvatarFallback className="bg-primary/10 text-sm font-medium text-primary">
                          {initials(c.contactName || c.contactHandle)}
                        </AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'truncate text-sm',
                              (c.godUnread ?? 0) > 0
                                ? 'font-semibold'
                                : 'font-medium',
                            )}
                          >
                            {c.contactName || c.contactHandle}
                          </span>
                          <span
                            className={cn(
                              'shrink-0 text-[11px]',
                              (c.godUnread ?? 0) > 0
                                ? 'font-medium text-primary'
                                : 'text-muted-foreground',
                            )}
                          >
                            {c.lastMessageAt ? fmtTime(c.lastMessageAt) : ''}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'truncate text-xs',
                              (c.godUnread ?? 0) > 0
                                ? 'font-medium text-foreground'
                                : 'text-muted-foreground',
                            )}
                          >
                            {parseReply(c.lastMessage || '').text || 'Нет сообщений'}
                          </span>
                          {/* Telegram semantics: the badge counts what YOU (the
                              god user, писавший от имени клиента) haven't read
                              yet — i.e. manager replies newer than your last
                              visit. NOT `unread`, which is the manager-side
                              counter and lights up after your own messages. */}
                          {(c.godUnread ?? 0) > 0 && (
                            <Badge
                              className="h-5 min-w-5 shrink-0 justify-center rounded-full bg-primary px-1.5 text-[11px] tabular-nums text-primary-foreground"
                              title="Непрочитанные сообщения от менеджера"
                            >
                              {c.godUnread}
                            </Badge>
                          )}
                        </div>
                        <span className="mt-1 inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {TYPE_LABEL[c.channelType] ?? c.channelType} ·{' '}
                          {managerNameOf(c.managerId)}
                        </span>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        {/* -------------------------- Thread --------------------------- */}
        <section
          className={cn(
            'relative min-w-0 flex-1 flex-col',
            showThread ? 'flex' : 'hidden md:flex',
          )}
          style={{
            transform: backDrag ? `translateX(${backDrag}px)` : undefined,
            transition: backDrag ? 'none' : 'transform 0.2s ease-out',
            // Promote to its own compositor layer only WHILE dragging, so the
            // swipe-back tracks the finger without jank on weak GPUs.
            willChange: backDrag ? 'transform' : undefined,
            touchAction: 'pan-y',
          }}
          onPointerDown={conversation ? onBackPointerDown : undefined}
          onPointerMove={conversation ? onBackPointerMove : undefined}
          onPointerUp={conversation ? onBackPointerEnd : undefined}
          onPointerCancel={conversation ? onBackPointerEnd : undefined}
        >
          {!conversation ? (
            <div className="hidden flex-1 items-center justify-center p-6 md:flex">
              <div className="flex flex-col items-center gap-3 text-center text-muted-foreground">
                <MessagesSquare className="size-12 opacity-40" />
                <p className="text-sm">Выберите диалог слева</p>
              </div>
            </div>
          ) : (
            <>
              <header className="flex items-center gap-2 border-b border-border bg-card/40 px-2 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] backdrop-blur sm:px-3">
                <button
                  type="button"
                  onClick={() => selectThread(null)}
                  className="flex size-10 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:hidden"
                  aria-label="Назад к списку"
                >
                  <ChevronLeft className="size-6" />
                </button>
                <Avatar className="size-10 shrink-0">
                  <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                    {initials(conversation.contactName || conversation.contactHandle)}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold leading-tight">
                    {conversation.contactName || conversation.contactHandle}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {TYPE_LABEL[conversation.channelType] ?? conversation.channelType} ·
                    Менеджер: {managerNameOf(conversation.managerId)}
                  </p>
                </div>
              </header>

              <div
                ref={scrollBoxRef}
                onScroll={onScrollBox}
                className="min-h-0 flex-1 overflow-y-auto overscroll-contain bg-muted/20 px-2 py-4 sm:px-3"
              >
                {/* Single content wrapper: the bottom-pinning ResizeObserver
                    watches THIS element, so async media loads / bubble
                    growth anywhere in the thread re-anchor the scroll. */}
                <div className="space-y-1.5">
                {loadingThread ? (
                  <div className="flex items-center justify-center py-16 text-muted-foreground">
                    <Loader2 className="size-5 animate-spin" />
                  </div>
                ) : messages.length === 0 ? (
                  <p className="py-16 text-center text-sm text-muted-foreground">
                    Сообщений пока нет. Напишите первое.
                  </p>
                ) : (
                  <>
                    {messages.length > visibleCount && (
                      <button
                        type="button"
                        onClick={() =>
                          setVisibleCount((c) => c + MESSAGES_WINDOW)
                        }
                        className="mx-auto mb-2 block rounded-full border border-border bg-background px-4 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      >
                        Показать ещё ({messages.length - visibleCount} скрыто)
                      </button>
                    )}
                    {messages.slice(-visibleCount).map((m, i, visible) => (
                      <MessageBubble
                        key={m.id}
                        message={m}
                        prev={visible[i - 1]}
                        onReply={startReply}
                        onMenu={setMenuFor}
                      />
                    ))}
                  </>
                )}
                <div ref={endRef} />
                </div>
              </div>

              {/* --------------------- Composer --------------------- */}
              <div
                className="border-t border-border bg-background px-2 pb-[max(0.625rem,env(safe-area-inset-bottom))] pt-2 sm:px-3"
                data-no-swipe
              >
                {(replyTo || editing) && (
                  <div className="mb-2 flex items-center gap-2 rounded-xl border-l-2 border-primary bg-muted/60 py-2 pl-3 pr-2">
                    {editing ? (
                      <Pencil className="size-4 shrink-0 text-primary" />
                    ) : (
                      <CornerUpLeft className="size-4 shrink-0 text-primary" />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium text-primary">
                        {editing ? 'Редактирование' : replyLabel}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {editing
                          ? snippetOf(editing) || 'Сообщение'
                          : replyTo
                            ? snippetOf(replyTo) || 'Сообщение'
                            : ''}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={cancelComposeExtras}
                      className="flex size-8 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      aria-label={editing ? 'Отменить редактирование' : 'Отменить ответ'}
                    >
                      <X className="size-4" />
                    </button>
                  </div>
                )}

                {recording ? (
                  <div className="flex items-center gap-3 rounded-3xl border border-input bg-card px-4 py-2.5">
                    <span className="flex items-center gap-2 text-sm text-destructive">
                      <span className="size-2.5 animate-pulse rounded-full bg-destructive" />
                      Запись…{' '}
                      <span className="tabular-nums">
                        {String(Math.floor(recordSecs / 60)).padStart(1, '0')}:
                        {String(recordSecs % 60).padStart(2, '0')}
                      </span>
                    </span>
                    <div className="ml-auto flex items-center gap-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-10 rounded-full"
                        onClick={() => finishRecording(true)}
                        aria-label="Отменить запись"
                      >
                        <Trash2 className="size-5" />
                      </Button>
                      <Button
                        size="icon"
                        className="size-11 rounded-full"
                        onClick={() => finishRecording(false)}
                        aria-label="Отправить голосовое"
                      >
                        <Send className="size-5" />
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-end gap-1.5">
                    <EmojiPicker
                      onPick={(emoji) => {
                        setDraft((d) => d + emoji)
                        composerRef.current?.focus()
                      }}
                    />
                    <textarea
                      ref={composerRef}
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
                          e.preventDefault()
                          sendMessage()
                        }
                        if (e.key === 'Escape' && (editing || replyTo)) {
                          cancelComposeExtras()
                        }
                      }}
                      rows={1}
                      placeholder={
                        editing
                          ? '��овый текст сообщения…'
                          : 'Сообщение от имени клиента…'
                      }
                      className="max-h-40 min-h-[52px] flex-1 resize-none rounded-3xl border border-input bg-card px-4 py-3.5 text-base leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    />
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      onChange={onFilePicked}
                      aria-hidden="true"
                      tabIndex={-1}
                    />
                    {!editing && (
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
                        aria-label="Прикрепить файл"
                      >
                        {uploading ? (
                          <Loader2 className="size-5 animate-spin" />
                        ) : (
                          <Paperclip className="size-5" />
                        )}
                      </button>
                    )}
                    {draft.trim() || editing ? (
                      <Button
                        size="icon"
                        className="size-12 shrink-0 rounded-full"
                        onClick={sendMessage}
                        disabled={pending || !draft.trim()}
                        aria-label={editing ? 'Сохранить' : 'Отправить'}
                      >
                        {pending ? (
                          <Loader2 className="size-5 animate-spin" />
                        ) : editing ? (
                          <Check className="size-5" />
                        ) : (
                          <Send className="size-5" />
                        )}
                      </Button>
                    ) : (
                      <Button
                        size="icon"
                        variant="secondary"
                        className="size-12 shrink-0 rounded-full"
                        onClick={startRecording}
                        disabled={uploading}
                        aria-label="Записать голосовое сообщение"
                      >
                        <Mic className="size-5" />
                      </Button>
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* --------------- Message action sheet (long-press) --------------- */}
      {menuFor && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 md:items-center"
          onClick={() => setMenuFor(null)}
          role="presentation"
        >
          <div
            className="w-full max-w-sm rounded-t-2xl bg-card p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-lg md:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
            role="menu"
            aria-label="Действия с сообщением"
          >
            <p className="truncate px-3 py-2 text-xs text-muted-foreground">
              {snippetOf(menuFor) || 'Сообщение'}
            </p>
            <SheetButton
              icon={<CornerUpLeft className="size-4" />}
              label="Ответить"
              onClick={() => menuAction('reply')}
            />
            <SheetButton
              icon={<Copy className="size-4" />}
              label="Копировать"
              onClick={() => menuAction('copy')}
            />
            {menuFor.direction === 'in' && !menuFor.mediaType && (
              <SheetButton
                icon={<Pencil className="size-4" />}
                label="Изменить"
                onClick={() => menuAction('edit')}
              />
            )}
            <SheetButton
              icon={<Trash2 className="size-4" />}
              label="Удалить"
              destructive
              onClick={() => menuAction('delete')}
            />
          </div>
        </div>
      )}

      <NewChatDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        channels={channels}
        onCreated={(id) => {
          setCreateOpen(false)
          void loadList({ silent: true })
          // Open the freshly created thread right away (as documented).
          if (id) selectThread(id)
        }}
      />
    </div>
  )
}

/** One row of the message action sheet. */
function SheetButton({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: React.ReactNode
  label: string
  onClick: () => void
  destructive?: boolean
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-sm font-medium transition-colors hover:bg-muted',
        destructive ? 'text-destructive' : 'text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/* Swipe-right-back thresholds (thread → list, anywhere in the thread). */
const THREAD_DRAG_MAX = 120
const THREAD_DRAG_TRIGGER = 70

/* How many newest messages are rendered initially / added per "show more". */
const MESSAGES_WINDOW = 50
