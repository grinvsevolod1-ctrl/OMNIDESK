'use client'

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { ChevronUp, History, Loader2, Reply, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import {
  BasicMessageMenu,
  MessageContextMenu,
  type ForwardTarget,
} from '@/components/manager/message-context-menu'
import {
  isMediaPlaceholder,
  MediaGalleryProvider,
  MessageMedia,
  MessageMediaAlbum,
} from '@/components/manager/inbox/message-media'
import { CHANNEL_VISUAL, dayLabel, timeShort } from '@/components/manager/inbox/visual'
import { DeliveryTicks } from '@/components/manager/inbox/atoms'
import type { Conversation, Message, PanelChannelType } from '@/lib/types'
import type { VisitorTyping } from '@/components/manager/inbox/use-inbox-realtime'

/** Max time gap for grouping consecutive media into one album (Telegram sends
 *  album members within a second or two of each other). */
const ALBUM_TIME_WINDOW_MS = 5000

/**
 * Do two consecutive messages belong to the same Telegram-style album? Only
 * photos and videos group (stickers, кружки, voice, files stay standalone), and
 * only within the same direction and a few seconds of each other — exactly how
 * a batch of photos arrives from / is sent to the provider. Deleted messages
 * never group so their marker stays readable.
 */
function sameAlbum(a: Message, b: Message): boolean {
  if (a.deletedAt || b.deletedAt) return false
  if (a.direction !== b.direction) return false
  const visual = (m: Message) =>
    m.mediaType === 'image' || m.mediaType === 'video'
  if (!visual(a) || !visual(b)) return false
  const gap = Math.abs(
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  )
  return gap <= ALBUM_TIME_WINDOW_MS
}

/**
 * Pre-compute albums for a thread: map each album HEAD id → its members and the
 * index right after the album (so tail-corner rounding can look past the group),
 * and a set of non-head member ids to SKIP in the render loop. Singles never
 * enter the map, so non-media threads pay almost nothing.
 */
function computeAlbums(thread: Message[]): {
  heads: Map<string, { items: Message[]; endIndex: number }>
  skip: Set<string>
} {
  const heads = new Map<string, { items: Message[]; endIndex: number }>()
  const skip = new Set<string>()
  let i = 0
  while (i < thread.length) {
    let j = i + 1
    while (j < thread.length && sameAlbum(thread[j - 1], thread[j])) j++
    if (j - i >= 2) {
      const items = thread.slice(i, j)
      heads.set(items[0].id, { items, endIndex: j })
      for (let k = i + 1; k < j; k++) skip.add(thread[k].id)
    }
    i = j
  }
  return { heads, skip }
}

/** Horizontal drag past this many px triggers a reply on release. */
const SWIPE_REPLY_THRESHOLD = 56

/**
 * Свайп-влево по сообщению → быстрый ответ (как в Telegram/WhatsApp).
 *
 * ОДИН слой: обёртка сама `w-full flex justify-*` (чтобы `max-w-[80%]` бабла
 * считался именно от неё — от полной ширины ряда, а не от промежуточного бокса;
 * это и был баг со съехавшими бабблами и полосой у края) И одновременно несёт
 * саму трансформацию сдвига и touch-обработчики. Отдельного вложенного
 * translateX-слоя больше нет.
 *
 * Только touch и только по горизонтали: пока жест вертикальный, лента
 * скроллится обычным образом (touch-action: pan-y). Величину сдвига дублируем в
 * ref, чтобы onTouchEnd видел актуальное значение без устаревшего замыкания —
 * поэтому свайп срабатывает КАЖДЫЙ раз, а не «один раз и всё».
 */
function SwipeToReply({
  enabled,
  align,
  onReply,
  children,
}: {
  enabled: boolean
  /** Сторона выравнивания баббла в ряду (out → вправо, in → влево). */
  align: 'start' | 'end'
  onReply: () => void
  children: ReactNode
}) {
  const [dx, setDx] = useState(0)
  const dxRef = useRef(0)
  const start = useRef<{ x: number; y: number; active: boolean } | null>(null)

  const set = (v: number) => {
    dxRef.current = v
    setDx(v)
  }
  const reset = () => {
    start.current = null
    set(0)
  }

  if (!enabled) return <>{children}</>

  return (
    <div
      className={cn(
        'relative flex w-full',
        align === 'end' ? 'justify-end' : 'justify-start',
      )}
      style={{
        transform: dx ? `translateX(${dx}px)` : undefined,
        transition: dx === 0 ? 'transform 0.18s ease-out' : 'none',
        touchAction: 'pan-y',
      }}
      onTouchStart={(e) => {
        const t = e.touches[0]
        start.current = { x: t.clientX, y: t.clientY, active: false }
      }}
      onTouchMove={(e) => {
        const s = start.current
        if (!s) return
        const t = e.touches[0]
        const dX = t.clientX - s.x
        const dY = t.clientY - s.y
        // Направление решаем один раз. Свайп — в ЛЮБУЮ сторону (в Telegram для
        // ответа тянут вправо), поэтому раньше свайп вправо «не работал» —
        // обрезался в 0. Теперь ведём баббл по знаку жеста в обе стороны.
        if (!s.active) {
          if (Math.abs(dX) > 8 && Math.abs(dX) > Math.abs(dY) * 1.2) {
            s.active = true
          } else if (Math.abs(dY) > 8) {
            start.current = null
            return
          } else {
            return
          }
        }
        set(Math.max(Math.min(dX, 88), -88))
      }}
      onTouchEnd={() => {
        if (
          start.current?.active &&
          Math.abs(dxRef.current) >= SWIPE_REPLY_THRESHOLD
        ) {
          onReply()
        }
        reset()
      }}
      onTouchCancel={reset}
    >
      {/* Иконка ответа проявляется по мере сдвига на трейлинг-краю (со стороны,
          противоположной движению пальца). pointer-events-none — не мешает
          тапам и не вылезает за обёртку. */}
      <div
        className={cn(
          'pointer-events-none absolute inset-y-0 flex items-center',
          dx > 0 ? 'left-1' : 'right-1',
        )}
        style={{ opacity: Math.min(1, Math.abs(dx) / SWIPE_REPLY_THRESHOLD) }}
        aria-hidden
      >
        <span className="rounded-full bg-primary/15 p-1.5 text-primary">
          <Reply className="size-4" />
        </span>
      </div>
      {children}
    </div>
  )
}

/**
 * The scrollable message feed of the open thread: older-history loader, day
 * separators, bubbles (media / reply preview / deleted markers / reactions),
 * album grids for grouped photos, the message context menu and the live
 * "visitor is typing" preview. Extracted verbatim from inbox-view.tsx.
 */
export function MessageList({
  active,
  activeId,
  thread,
  threadLoading = false,
  noOlder,
  loadingOlder,
  onLoadOlder,
  forwardTargets,
  activeTyping,
  messagesScrollRef,
  onThreadScroll,
  onReply,
  onEdit,
  onReact,
  onCopy,
  onForward,
  onDelete,
  onShowHistory,
  highlightedId,
  onBubbleClick,
  readOnlyActions = false,
  hideDeliveryStatus = false,
}: {
  active: Conversation
  activeId: string | null
  thread: Message[]
  /** True while a cold thread (outside the SSR preload slice) hydrates. */
  threadLoading?: boolean
  noOlder: Record<string, boolean>
  loadingOlder: boolean
  onLoadOlder: () => void
  forwardTargets: ForwardTarget[]
  activeTyping: VisitorTyping | null
  messagesScrollRef: RefObject<HTMLDivElement | null>
  onThreadScroll: () => void
  onReply: (message: Message) => void
  onEdit: (message: Message) => void
  onReact: (message: Message, emoji: string) => void
  onCopy: (message: Message) => void
  onForward: (message: Message, toConversationId: string) => void
  onDelete: (message: Message) => void
  onShowHistory: (message: Message) => void
  /** Подсветить сообщение (навигация поиска/медиа по треду). */
  highlightedId?: string | null
  /** Клик по бабблу — выбор медиа в режиме «прикрепить к карточке». */
  onBubbleClick?: (message: Message) => void
  /**
   * Роль без провайдер-действий (куратор): полное контекстное меню и toggle
   * реакций отключаются, вместо них — базовое меню «Ответить/Копировать».
   * Реакции при этом всё равно ОТОБРАЖАЮТСЯ (они пришли от собеседника).
   */
  readOnlyActions?: boolean
  /**
   * Скрыть тики доставки/ошибки отправки у исходящих (роль без владения
   * отправкой — куратор по кадрам). Диалоги передаются человеку/ведутся из
   * другого места, поэтому статус «Не отправлено» вводил бы куратора в
   * заблуждение — будто его сообщение не ушло. Время при этом остаётся.
   */
  hideDeliveryStatus?: boolean
}) {
  // Infinite scroll up: when the top sentinel becomes visible near the top of
  // the feed, older messages load automatically — no button press needed.
  // Latest callback/flag live in refs (synced in an effect, per the
  // react-hooks/refs rule) so the observer isn't re-created per render.
  const canLoadOlder = Boolean(
    activeId && thread.length >= 30 && !noOlder[activeId],
  )
  const topSentinelRef = useRef<HTMLDivElement | null>(null)
  const loadOlderRef = useRef(onLoadOlder)
  const loadingOlderRef = useRef(loadingOlder)
  useEffect(() => {
    loadOlderRef.current = onLoadOlder
    loadingOlderRef.current = loadingOlder
  }, [onLoadOlder, loadingOlder])
  useEffect(() => {
    if (!canLoadOlder) return
    const sentinel = topSentinelRef.current
    const root = messagesScrollRef.current
    if (!sentinel || !root) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !loadingOlderRef.current) {
          loadOlderRef.current()
        }
      },
      // Start fetching a bit BEFORE the very top so scrolling feels seamless.
      { root, rootMargin: '200px 0px 0px 0px' },
    )
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [canLoadOlder, activeId, messagesScrollRef])

  // Group consecutive photos/videos into Telegram-style albums (recomputed only
  // when the thread reference changes).
  const albums = useMemo(() => computeAlbums(thread), [thread])

  // Тап по цитате-ответу → прыжок к оригиналу (как в Telegram): скроллим к нему
  // и на пару секунд подсвечиваем кольцом. Контейнер прокрутки уже прокинут
  // сюда (messagesScrollRef), так что это работает и у менеджера, и у куратора
  // без правок родителей. Если оригинал ещё не догружен в DOM — тихо ничего.
  const [jumpHighlight, setJumpHighlight] = useState<string | null>(null)
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const jumpToMessage = (id: string, attempt = 0) => {
    const container = messagesScrollRef.current
    if (!container) return
    const el = container.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
    if (!el) {
      // Оригинал мог быть ещё не отрисован (content-visibility / ленивое окно
      // ленты) — пробуем несколько раз с нарастающей паузой, потом сдаёмся.
      if (attempt < 5) {
        window.setTimeout(() => jumpToMessage(id, attempt + 1), 80 * (attempt + 1))
      }
      return
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setJumpHighlight(id)
    if (jumpTimer.current) clearTimeout(jumpTimer.current)
    jumpTimer.current = setTimeout(() => setJumpHighlight(null), 1600)
  }
  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current)
    },
    [],
  )

  return (
    <div
      ref={messagesScrollRef}
      onScroll={onThreadScroll}
      className="scrollbar-thin min-h-0 flex-1 overflow-y-auto overflow-x-hidden bg-muted/20 px-3 py-4 sm:px-6"
      style={{
        backgroundImage:
          'radial-gradient(color-mix(in oklch, var(--foreground) 5%, transparent) 1px, transparent 1px)',
        backgroundSize: '22px 22px',
      }}
    >
      <MediaGalleryProvider messages={thread}>
      <div className="mx-auto flex max-w-3xl flex-col gap-1">
        {/* Cold-thread hydration: transcript is being fetched on first open. */}
        {threadLoading && thread.length === 0 ? (
          <div
            className="flex justify-center py-8 text-muted-foreground"
            role="status"
            aria-label="Загружаю переписку"
          >
            <Loader2 className="size-5 animate-spin" />
          </div>
        ) : null}
        {/* Older-history loader: shown only when the thread was truncated to
            the most-recent slice (SSR batch preloads 30 per thread) and there
            may be more to fetch. */}
        {canLoadOlder ? (
          <div className="mb-2 flex justify-center">
            {/* Sentinel: intersection with it auto-loads older history. */}
            <div ref={topSentinelRef} aria-hidden className="h-px w-px" />
            <Button
              variant="ghost"
              size="sm"
              onClick={onLoadOlder}
              disabled={loadingOlder}
              className="gap-1.5 text-xs text-muted-foreground"
            >
              {loadingOlder ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <ChevronUp className="size-3.5" />
              )}
              {loadingOlder ? 'Загружаю…' : 'Загрузить ранние сообщения'}
            </Button>
          </div>
        ) : null}
        {thread.map((m, i) => {
          // Album members (all but the first) are folded into the head's grid.
          if (albums.skip.has(m.id)) return null
          const album = albums.heads.get(m.id)
          const prev = thread[i - 1]
          const showDay =
            !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt)
          const isOut = m.direction === 'out'
          const prevSameSide =
            prev && prev.direction === m.direction && !showDay
          // For an album head, "next" is the message AFTER the whole group, so
          // the tail corner and end-of-thread animation look past the members
          // we skipped.
          const nextIndex = album ? album.endIndex : i + 1
          const next = thread[nextIndex]
          // Последний в «пачке» одного отправителя — только у него рисуем
          // острый уголок-хвост (как в Telegram); внутри группы углы скруглены.
          const nextSameSide =
            next &&
            next.direction === m.direction &&
            dayLabel(next.createdAt) === dayLabel(m.createdAt)
          const isLast = nextIndex >= thread.length
          return (
            // content-visibility lets the browser skip layout/paint of
            // off-screen bubbles — a large win on 300-message threads.
            <div
              key={m.id}
              data-message-id={m.id}
              // Анимируем вход ТОЛЬКО у последнего сообщения — новые
              // приходящие/отправленные плавно появляются, а прокрутка
              // истории не дёргается.
              className={isLast ? 'motion-safe:animate-message-in' : undefined}
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: 'auto 56px',
              }}
            >
              {showDay ? (
                <div className="my-3 flex justify-center">
                  <span className="rounded-full bg-card/90 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/50">
                    {dayLabel(m.createdAt)}
                  </span>
                </div>
              ) : null}
              <div
                className={cn(
                  'flex',
                  isOut ? 'justify-end' : 'justify-start',
                  prevSameSide ? 'mt-0.5' : 'mt-2',
                )}
              >
                {(() => {
                  const isDeleted = Boolean(m.deletedAt)
                  // Deleted messages KEEP their content; we just append a
                  // marker so nothing is lost. Label reflects who deleted
                  // it (the contact vs. us), defaulting when unknown.
                  const deletedLabel = isDeleted
                    ? m.deletedOrigin === 'self'
                      ? 'Вы удалили это сообщение'
                      : m.deletedOrigin === 'remote'
                        ? 'Удалено собеседником'
                        : 'Сообщение удалено'
                    : null
                  // Stickers render even without a URL (optimistic
                  // outgoing ones fall back to their emoji).
                  const hasMedia = Boolean(
                    m.mediaType && (m.mediaUrl || m.mediaType === 'sticker'),
                  )
                  // Stickers float free (no bubble chrome); everything
                  // else keeps the normal bubble styling.
                  const bare = m.mediaType === 'sticker'
                  // Hide the text body for stickers (the sticker itself
                  // conveys it) and for synthetic media placeholders.
                  const showBody =
                    m.body &&
                    m.mediaType !== 'sticker' &&
                    !(hasMedia && isMediaPlaceholder(m.body))
                  const isTelegram = active.channelType === 'telegram'
                  // Полные провайдер-действия только у менеджера на Telegram;
                  // у куратора (readOnlyActions) — базовое меню ниже.
                  const canAct = isTelegram && !readOnlyActions
                  const reactions = m.reactions ?? []

                  const bubble = (
                    <div
                      className={cn(
                        'text-sm',
                        bare
                          ? ''
                          : cn(
                              'px-3 py-2 shadow-sm',
                              isOut
                                ? cn(
                                    'rounded-2xl bg-primary text-primary-foreground',
                                    !nextSameSide && 'rounded-br-sm',
                                  )
                                : cn(
                                    'rounded-2xl border border-border bg-card text-foreground',
                                    !nextSameSide && 'rounded-bl-sm',
                                  ),
                            ),
                      )}
                    >
                      {!isOut && m.author && !prevSameSide ? (
                        <p
                          className={cn(
                            'mb-0.5 text-[11px] font-semibold',
                            CHANNEL_VISUAL[
                              active.channelType as PanelChannelType
                            ]?.accentText,
                          )}
                        >
                          {m.author}
                        </p>
                      ) : null}
                      {m.replyTo ? (
                        <button
                          type="button"
                          onClick={(e) => {
                            // Не даём клику всплыть в onBubbleClick (режим
                            // прикрепления медиа к карточке).
                            e.stopPropagation()
                            if (m.replyTo) jumpToMessage(m.replyTo.id)
                          }}
                          className={cn(
                            'mb-1 block w-full rounded-md border-l-2 px-2 py-1 text-left text-xs transition-colors',
                            isOut
                              ? 'border-primary-foreground/50 bg-primary-foreground/10 hover:bg-primary-foreground/20'
                              : 'border-primary/60 bg-muted/60 hover:bg-muted',
                          )}
                        >
                          <p className="font-semibold opacity-90">
                            {m.replyTo.author || 'Сообщение'}
                          </p>
                          <p className="truncate opacity-75">
                            {m.replyTo.body ||
                              (m.replyTo.mediaType ? '[вложение]' : '')}
                          </p>
                        </button>
                      ) : null}
                      {hasMedia ? (
                        <div
                          className={cn(
                            showBody && !bare ? 'mb-1' : '',
                            // Dim preserved media when the message was
                            // deleted, but keep it openable/saveable.
                            isDeleted ? 'opacity-60' : '',
                          )}
                        >
                          {album ? (
                            <MessageMediaAlbum items={album.items} />
                          ) : (
                            <MessageMedia message={m} />
                          )}
                        </div>
                      ) : null}
                      {deletedLabel ? (
                        <p
                          className={cn(
                            'mb-0.5 flex items-center gap-1 text-[11px] font-medium italic',
                            isOut
                              ? 'text-primary-foreground/80'
                              : 'text-muted-foreground',
                          )}
                        >
                          <Trash2 className="size-3 shrink-0" />
                          {deletedLabel}
                        </p>
                      ) : null}
                      <div className="flex flex-wrap items-end justify-end gap-x-2">
                        {showBody ? (
                          <p
                            className={cn(
                              'whitespace-pre-wrap break-words text-left leading-relaxed [overflow-wrap:anywhere]',
                              isDeleted ? 'italic opacity-60' : '',
                            )}
                          >
                            {m.body}
                          </p>
                        ) : null}
                        <span
                          className={cn(
                            'ml-auto flex shrink-0 items-center gap-0.5 text-[10px] leading-none',
                            bare
                              ? 'text-muted-foreground'
                              : isOut
                                ? 'text-primary-foreground/70'
                                : 'text-muted-foreground',
                          )}
                        >
                          {m.editedAt ? (
                            <button
                              type="button"
                              onClick={() => onShowHistory(m)}
                              title="Показать историю изменений"
                              className={cn(
                                'mr-0.5 flex items-center gap-0.5 rounded px-0.5 italic underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80',
                                isOut
                                  ? 'text-primary-foreground/70'
                                  : 'text-muted-foreground',
                              )}
                            >
                              <History className="size-2.5" />
                              изменено
                            </button>
                          ) : null}
                          {timeShort(m.createdAt)}
                          {isOut && !hideDeliveryStatus ? (
                            <DeliveryTicks
                              status={m.status}
                              errorReason={m.errorReason}
                            />
                          ) : null}
                        </span>
                      </div>
                    </div>
                  )

                  return (
                    <SwipeToReply
                      enabled={isTelegram && !isDeleted}
                      align={isOut ? 'end' : 'start'}
                      onReply={() => onReply(m)}
                    >
                    <div
                      className={cn(
                        'flex max-w-[80%] flex-col gap-1 sm:max-w-[70%]',
                        isOut ? 'items-end' : 'items-start',
                        // Подсветка цели поиска/медиа-навигации/прыжка к
                        // цитате — как в Telegram: мягкое кольцо вокруг
                        // сообщения.
                        (highlightedId === m.id || jumpHighlight === m.id) &&
                          'rounded-2xl ring-2 ring-primary/70 ring-offset-2 ring-offset-background transition-shadow',
                        onBubbleClick && 'cursor-pointer',
                      )}
                      onClick={
                        onBubbleClick ? () => onBubbleClick(m) : undefined
                      }
                    >
                      {canAct ? (
                        <MessageContextMenu
                          message={m}
                          forwardTargets={forwardTargets}
                          onReply={onReply}
                          onReact={onReact}
                          onCopy={onCopy}
                          onForward={onForward}
                          onEdit={isOut ? onEdit : undefined}
                          onDelete={onDelete}
                        >
                          {bubble}
                        </MessageContextMenu>
                      ) : readOnlyActions ? (
                        <BasicMessageMenu
                          message={m}
                          // Ответ-цитата пробрасывается только на Telegram,
                          // где воркер её поддерживает; копирование — везде.
                          onReply={isTelegram ? onReply : undefined}
                          onCopy={onCopy}
                        >
                          {bubble}
                        </BasicMessageMenu>
                      ) : (
                        bubble
                      )}
                      {reactions.length ? (
                        <div
                          className={cn(
                            'flex flex-wrap gap-1',
                            isOut ? 'justify-end' : 'justify-start',
                          )}
                        >
                          {reactions.map((r, ri) => (
                            <button
                              key={`${r.emoji}_${ri}`}
                              type="button"
                              onClick={() =>
                                canAct && onReact(m, r.fromMe ? '' : r.emoji)
                              }
                              className={cn(
                                'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs ring-1 transition-colors',
                                r.fromMe
                                  ? 'bg-primary/15 ring-primary/40'
                                  : 'bg-muted ring-border',
                              )}
                              aria-label={`Реакция ${r.emoji}`}
                            >
                              <span>{r.emoji}</span>
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    </SwipeToReply>
                  )
                })()}
              </div>
            </div>
          )
        })}
        {activeTyping ? (
          <div className="flex flex-col items-start gap-1">
            <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-3 py-2">
              <span className="inline-flex gap-1" aria-hidden>
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
                <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
              </span>
              <span className="text-xs text-muted-foreground">
                {activeTyping.name} печатает
              </span>
            </div>
            {activeTyping.draft ? (
              <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-dashed border-border bg-card px-3 py-2 text-sm italic text-muted-foreground">
                {activeTyping.draft}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      </MediaGalleryProvider>
    </div>
  )
}
