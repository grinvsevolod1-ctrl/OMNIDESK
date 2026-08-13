'use client'

/**
 * Телеграм-стиль поиск и навигация по открытому диалогу.
 *
 * Три режима:
 *  - 'text'       — поиск по тексту сообщений (кнопка-лупа в шапке треда);
 *  - 'video_note' — навигация по кружкам диалога (из карточки лида);
 *  - 'photo'      — навигация по фото диалога («Документ» в карточке лида).
 *
 * Механика как в Telegram: стрелки/кнопки prev-next ходят по совпадениям,
 * тред скроллится к сообщению и подсвечивает его. Если сообщение ещё не
 * загружено (старая история) — страницы догружаются автоматически до цели.
 * Esc закрывает бар; позиция запоминается per-диалог и режим, повторное
 * открытие продолжает с того же места. В медиа-режимах клик по сообщению
 * или кнопка «Прикрепить» показывают подтверждение перед закреплением.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import {
  ChevronDown,
  ChevronUp,
  CircleDot,
  FileImage,
  Loader2,
  Paperclip,
  Search,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { searchThreadMessagesAction } from '@/app/actions/messages'
import {
  attachLeadVideoNoteAction,
  listConversationPhotosAction,
  listConversationVideoNotesAction,
} from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'

export type ThreadSearchMode = 'text' | 'video_note' | 'photo'

interface SearchHit {
  id: string
  createdAt: string
  snippet?: string
}

export interface ThreadSearchState {
  open: boolean
  mode: ThreadSearchMode
  /** id подсвеченного сообщения (цель навигации). */
  highlightedId: string | null
  /** Карточка, к которой прикрепляем медиа (медиа-режимы). */
  attachLeadCardId: string | null
  openText: () => void
  openMedia: (mode: 'video_note' | 'photo', leadCardId: string) => void
  close: () => void
  /** Клик по сообщению в треде в медиа-режиме — предложить прикрепить. */
  onMessageClick: (m: Message) => void
  bar: React.ReactNode
}

/** Позиции «где остановились» — живут на время сессии вкладки. */
const positionMemory = new Map<string, number>()

export function useThreadSearch({
  conversationId,
  loadOlder,
  scrollToMessage,
  onAttached,
}: {
  conversationId: string | null
  /** Догрузить страницу старой истории; false — грузить больше нечего. */
  loadOlder: () => Promise<boolean>
  scrollToMessage: (id: string) => boolean
  /** Вызывается после успешного прикрепления медиа к карточке. */
  onAttached: (leadCardId: string) => void
}): ThreadSearchState {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<ThreadSearchMode>('text')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [index, setIndex] = useState(-1)
  const [busy, setBusy] = useState(false)
  const [attachLeadCardId, setAttachLeadCardId] = useState<string | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<SearchHit | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const generation = useRef(0)

  const memoryKey = conversationId ? `${conversationId}:${mode}` : null

  /* Смена диалога сбрасывает поиск полностью (кроме памяти позиций). */
  const [prevConv, setPrevConv] = useState(conversationId)
  if (prevConv !== conversationId) {
    setPrevConv(conversationId)
    setOpen(false)
    setQuery('')
    setHits([])
    setIndex(-1)
    setConfirmTarget(null)
    setAttachLeadCardId(null)
  }

  const close = useCallback(() => {
    if (memoryKey && index >= 0) positionMemory.set(memoryKey, index)
    setOpen(false)
    setConfirmTarget(null)
  }, [memoryKey, index])

  /**
   * Перейти к сообщению: скроллим, если оно загружено; иначе догружаем
   * историю страницами, пока цель не появится (или история не кончится).
   */
  const goTo = useCallback(
    async (hit: SearchHit) => {
      if (scrollToMessage(hit.id)) return
      const gen = ++generation.current
      setBusy(true)
      try {
        // Максимум 30 страниц за один переход — защита от бесконечного цикла.
        for (let i = 0; i < 30; i++) {
          if (generation.current !== gen) return
          const hasMore = await loadOlder()
          if (scrollToMessage(hit.id)) return
          if (!hasMore) break
        }
        toast.error('Не удалось долистать до сообщения')
      } finally {
        if (generation.current === gen) setBusy(false)
      }
    },
    [scrollToMessage, loadOlder],
  )

  const step = useCallback(
    (dir: 1 | -1) => {
      if (hits.length === 0) return
      const next =
        index < 0
          ? 0
          : (index + (dir === 1 ? 1 : hits.length - 1)) % hits.length
      setIndex(next)
      void goTo(hits[next])
    },
    [hits, index, goTo],
  )

  /** Открыть текстовый поиск (лупа в шапке). */
  const openText = useCallback(() => {
    setMode('text')
    setAttachLeadCardId(null)
    setOpen(true)
    setConfirmTarget(null)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [])

  /** Открыть медиа-навигацию из карточки лида. */
  const openMedia = useCallback(
    (m: 'video_note' | 'photo', leadCardId: string) => {
      if (!conversationId) return
      setMode(m)
      setAttachLeadCardId(leadCardId)
      setOpen(true)
      setConfirmTarget(null)
      setBusy(true)
      const gen = ++generation.current
      const list =
        m === 'video_note'
          ? listConversationVideoNotesAction(conversationId)
          : listConversationPhotosAction(conversationId)
      void list
        .then((items) => {
          if (generation.current !== gen) return
          // От новых к старым — как поиск в Telegram.
          const ordered = [...items].reverse().map((n) => ({
            id: n.messageId,
            createdAt: n.createdAt,
          }))
          setHits(ordered)
          const remembered = positionMemory.get(`${conversationId}:${m}`)
          const start =
            remembered !== undefined && remembered < ordered.length
              ? remembered
              : ordered.length > 0
                ? 0
                : -1
          setIndex(start)
          if (start >= 0) void goTo(ordered[start])
        })
        .catch(() =>
          toast.error(
            m === 'video_note'
              ? 'Не удалось найти кружки'
              : 'Не удалось найти фото',
          ),
        )
        .finally(() => {
          if (generation.current === gen) setBusy(false)
        })
    },
    [conversationId, goTo],
  )

  /* Текстовый поиск — с дебаунсом по вводу. */
  useEffect(() => {
    if (!open || mode !== 'text' || !conversationId) return
    const q = query.trim()
    if (q.length < 2) {
      setHits([])
      setIndex(-1)
      return
    }
    const gen = ++generation.current
    const t = setTimeout(() => {
      setBusy(true)
      void searchThreadMessagesAction(conversationId, q)
        .then((res) => {
          if (generation.current !== gen) return
          const ordered = res.map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            snippet: r.snippet,
          }))
          setHits(ordered)
          setIndex(ordered.length > 0 ? 0 : -1)
          if (ordered.length > 0) void goTo(ordered[0])
        })
        .catch(() => toast.error('Поиск не удался'))
        .finally(() => {
          if (generation.current === gen) setBusy(false)
        })
    }, 350)
    return () => clearTimeout(t)
  }, [open, mode, conversationId, query, goTo])

  /* Esc закрывает бар (capture — раньше обработчика «закрыть диалог»). */
  useEffect(() => {
    if (!open) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        close()
      } else if (e.key === 'Enter' && mode === 'text' && !e.shiftKey) {
        // Enter в поле поиска — следующее совпадение (как в Telegram).
        if (document.activeElement === inputRef.current) {
          e.preventDefault()
          step(1)
        }
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open, close, mode, step])

  const current = index >= 0 ? hits[index] : null

  /** Прикрепить подтверждённое медиа к карточке лида. */
  const attach = useCallback(() => {
    if (!confirmTarget || !attachLeadCardId || !conversationId) return
    if (mode !== 'video_note' && mode !== 'photo') return
    setBusy(true)
    void attachLeadVideoNoteAction({
      leadCardId: attachLeadCardId,
      conversationId,
      messageId: confirmTarget.id,
      kind: mode,
    })
      .then((res) => {
        if (res.ok) {
          toast.success(res.message)
          onAttached(attachLeadCardId)
          setConfirmTarget(null)
        } else {
          toast.error(res.message)
        }
      })
      .finally(() => setBusy(false))
  }, [confirmTarget, attachLeadCardId, conversationId, mode, onAttached])

  /** Клик по сообщению в треде в медиа-режиме. */
  const onMessageClick = useCallback(
    (m: Message) => {
      if (!open || mode === 'text' || !attachLeadCardId) return
      const hit = hits.find((h) => h.id === m.id)
      if (!hit) return
      const idx = hits.indexOf(hit)
      setIndex(idx)
      setConfirmTarget(hit)
    },
    [open, mode, attachLeadCardId, hits],
  )

  const modeLabel =
    mode === 'video_note' ? 'Кружки' : mode === 'photo' ? 'Фото' : null

  const bar = useMemo(() => {
    if (!open) return null
    return (
      <div className="flex shrink-0 flex-col border-b border-border bg-card">
        <div className="flex h-12 items-center gap-2 px-3 sm:px-4">
          {mode === 'text' ? (
            <>
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <Input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Поиск по диалогу…"
                className="h-8 flex-1 border-none bg-transparent px-1 shadow-none focus-visible:ring-0"
              />
            </>
          ) : (
            <span className="flex items-center gap-1.5 text-sm font-medium">
              {mode === 'video_note' ? (
                <CircleDot className="size-4 text-primary" />
              ) : (
                <FileImage className="size-4 text-primary" />
              )}
              {modeLabel}
              <span className="text-xs font-normal text-muted-foreground">
                — выберите и прикрепите к карточке
              </span>
            </span>
          )}

          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {busy ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : hits.length > 0 ? (
              `${index + 1} из ${hits.length}`
            ) : mode === 'text' && query.trim().length >= 2 ? (
              'Не найдено'
            ) : mode !== 'text' ? (
              mode === 'video_note'
                ? 'В диалоге нет кружков'
                : 'В диалоге нет фото'
            ) : null}
          </span>

          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={hits.length === 0 || busy}
              onClick={() => step(-1)}
              aria-label="Предыдущее"
            >
              <ChevronUp className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={hits.length === 0 || busy}
              onClick={() => step(1)}
              aria-label="Следующее"
            >
              <ChevronDown className="size-4" />
            </Button>
            {mode !== 'text' && current ? (
              <Button
                variant="default"
                size="sm"
                className="ml-1 gap-1.5"
                disabled={busy}
                onClick={() => setConfirmTarget(current)}
              >
                <Paperclip className="size-3.5" />
                Прикрепить
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={close}
              aria-label="Закрыть поиск (Esc)"
            >
              <X className="size-4" />
            </Button>
          </div>
        </div>

        {/* Подтверждение прикрепления — inline, без модалки. */}
        {confirmTarget ? (
          <div className="flex items-center gap-2 border-t border-border bg-primary/5 px-3 py-2 sm:px-4">
            <p className="min-w-0 flex-1 text-xs">
              Прикрепить{' '}
              {mode === 'video_note' ? 'этот кружок' : 'это фото'} к карточке
              лида?
            </p>
            <Button size="sm" disabled={busy} onClick={attach}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
              Да, прикрепить
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmTarget(null)}
            >
              Отмена
            </Button>
          </div>
        ) : null}
      </div>
    )
  }, [
    open,
    mode,
    modeLabel,
    query,
    hits.length,
    index,
    busy,
    current,
    confirmTarget,
    step,
    close,
    attach,
  ])

  return {
    open,
    mode,
    highlightedId: open && current ? current.id : null,
    attachLeadCardId: open ? attachLeadCardId : null,
    openText,
    openMedia,
    close,
    onMessageClick,
    bar,
  }
}
