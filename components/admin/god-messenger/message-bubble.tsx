'use client'

import {
  memo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import {
  Ban,
  Check,
  CheckCheck,
  CornerUpLeft,
  FileText,
  Loader2,
  Pencil,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'
import { VideoNotePlayer } from '@/components/shared/video-note-player'
import { fmtDayChip, fmtTime } from './utils'
import { parseReply } from './reply'

/* Swipe-left-to-reply thresholds (single bubble). */
const DRAG_MAX = 84
const DRAG_TRIGGER = 56
/* Long-press duration that opens the message action sheet (like Telegram). */
const LONG_PRESS_MS = 420

export type BubbleAction = 'menu'

/**
 * One message. Perspective is inverted vs. the manager inbox: an INBOUND message
 * (direction 'in') is what the god typed AS THE CLIENT, so it sits on the RIGHT
 * as "mine"; an OUTBOUND message (direction 'out') is the manager's reply, shown
 * on the LEFT as "theirs". Swipe a bubble left (like Telegram) to reply to it;
 * long-press (touch) or right-click (desktop) opens the action sheet.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  prev,
  next,
  isLast,
  onReply,
  onMenu,
}: {
  message: Message
  prev?: Message
  next?: Message
  /** Последнее сообщение треда — только оно анимирует свой вход. */
  isLast?: boolean
  onReply: (message: Message) => void
  onMenu: (message: Message) => void
}) {
  const mine = message.direction === 'in'
  const deleted = Boolean(message.deletedAt)
  const { quote: legacyQuote, text } = parseReply(message.body)

  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const start = useRef<{ x: number; y: number } | null>(null)
  const axis = useRef<null | 'h' | 'v'>(null)
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressFired = useRef(false)

  const clearPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    start.current = { x: e.clientX, y: e.clientY }
    axis.current = null
    pressFired.current = false
    if (e.pointerType === 'touch' && !deleted) {
      clearPress()
      pressTimer.current = setTimeout(() => {
        pressFired.current = true
        onMenu(message)
      }, LONG_PRESS_MS)
    }
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return
    const dx = e.clientX - start.current.x
    const dy = e.clientY - start.current.y
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) clearPress()
    if (axis.current === null) {
      // Claim ONLY leftward drags (reply). A rightward drag must stay
      // unclaimed so it bubbles up to the thread's swipe-back gesture.
      if (dx < -8 && Math.abs(dx) > Math.abs(dy)) {
        axis.current = 'h'
        setDragging(true)
        try {
          e.currentTarget.setPointerCapture(e.pointerId)
        } catch {
          /* ignore */
        }
      } else if (Math.abs(dy) > 8 || dx > 8) {
        axis.current = 'v'
      }
    }
    if (axis.current === 'h') {
      // Swipe left to reply; clamp past the trigger.
      setDragX(Math.max(-DRAG_MAX, Math.min(0, dx)))
    }
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    clearPress()
    if (axis.current === 'h') {
      if (dragX <= -DRAG_TRIGGER && !deleted) onReply(message)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    start.current = null
    axis.current = null
    setDragging(false)
    setDragX(0)
  }

  // Day separator when the calendar day changes.
  const showDay =
    !prev ||
    new Date(prev.createdAt).toDateString() !==
      new Date(message.createdAt).toDateString()

  // Последний в «пачке» одного отправителя за один день — только у него
  // острый уголок-хвост (Telegram-стиль); внутри группы углы скруглены.
  const nextSameSide =
    next &&
    next.direction === message.direction &&
    new Date(next.createdAt).toDateString() ===
      new Date(message.createdAt).toDateString()

  const revealProgress = Math.min(1, -dragX / DRAG_TRIGGER)

  return (
    <>
      {showDay && (
        <div className="flex justify-center py-2">
          <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground">
            {fmtDayChip(message.createdAt)}
          </span>
        </div>
      )}
      <div
        className={cn(
          'relative select-none',
          // Анимируем вход только у последнего пузыря — новое сообщение
          // мягко появляется, история при прокрутке не дёргается.
          isLast && 'motion-safe:animate-message-in',
        )}
        // content-visibility: browser skips layout/paint of off-screen bubbles.
        style={{
          touchAction: 'pan-y',
          contentVisibility: 'auto',
          containIntrinsicSize: 'auto 56px',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onContextMenu={(e) => {
          if (deleted) return
          e.preventDefault()
          onMenu(message)
        }}
      >
        {/* Reply affordance revealed while swiping. */}
        <div
          className="pointer-events-none absolute inset-y-0 right-1 flex items-center"
          style={{ opacity: revealProgress }}
          aria-hidden="true"
        >
          <div
            className={cn(
              'flex size-8 items-center justify-center rounded-full transition-colors',
              revealProgress >= 1
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground',
            )}
          >
            <CornerUpLeft className="size-4" />
          </div>
        </div>

        <div
          className={cn('flex', mine ? 'justify-end' : 'justify-start')}
          style={{
            transform: `translateX(${dragX}px)`,
            transition: dragging ? 'none' : 'transform 0.2s ease-out',
          }}
        >
          <div
            className={cn(
              'max-w-[82%] rounded-2xl px-3.5 py-2 text-sm sm:max-w-[75%]',
              mine
                ? cn(
                    'bg-primary text-primary-foreground',
                    !nextSameSide && 'rounded-br-sm',
                  )
                : cn(
                    'border border-border bg-card text-foreground',
                    !nextSameSide && 'rounded-bl-sm',
                  ),
            )}
          >
            {deleted ? (
              <p
                className={cn(
                  'flex items-center gap-1.5 italic leading-relaxed',
                  mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
                )}
              >
                <Ban className="size-3.5 shrink-0" />
                Сообщение удалено
              </p>
            ) : (
              <>
                {/* Real reply (reply_to_message_id) with legacy fallback. */}
                {(message.replyTo || legacyQuote) && (
                  <div
                    className={cn(
                      'mb-1 rounded-md border-l-2 px-2 py-1 text-xs',
                      mine
                        ? 'border-primary-foreground/50 bg-primary-foreground/10 text-primary-foreground/80'
                        : 'border-primary/50 bg-muted text-muted-foreground',
                    )}
                  >
                    {message.replyTo ? (
                      <>
                        <span className="block font-medium">
                          {message.replyTo.author || 'Сообщение'}
                        </span>
                        <span className="line-clamp-2 break-words">
                          {message.replyTo.body || mediaLabel(message.replyTo.mediaType)}
                        </span>
                      </>
                    ) : (
                      <span className="line-clamp-2 break-words">{legacyQuote}</span>
                    )}
                  </div>
                )}

                {message.mediaType && message.mediaUrl && (
                  <MediaContent message={message} mine={mine} />
                )}

                {/* Hide auto-generated "[Фото]"-style bodies under real media. */}
                {text && !(message.mediaType && text.startsWith('[')) && (
                  <p className="whitespace-pre-wrap break-words leading-relaxed">
                    {text}
                  </p>
                )}
              </>
            )}
            <span
              className={cn(
                'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
                mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
              )}
            >
              {!deleted && message.editedAt && (
                <span className="inline-flex items-center gap-0.5">
                  <Pencil className="size-2.5" />
                  изменено
                </span>
              )}
              {fmtTime(message.createdAt)}
              {mine &&
                !deleted &&
                (message.status === 'read' ? (
                  <CheckCheck className="size-3" />
                ) : (
                  <Check className="size-3" />
                ))}
            </span>
          </div>
        </div>
      </div>
    </>
  )
})

/** Фото с приглушённой заглушкой-«шиммером» на время загрузки — картинка
 *  плавно проявляется, без пустого прыжка (Telegram-стиль). */
function ImageWithSkeleton({
  url,
  alt,
  uploading,
}: {
  url: string
  alt: string
  uploading?: boolean
}) {
  const [loaded, setLoaded] = useState(false)
  return (
    <span
      className={cn(
        'relative block overflow-hidden rounded-lg',
        !loaded && 'min-h-40 min-w-40 skeleton-shimmer bg-muted/60',
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url || '/placeholder.svg'}
        alt={alt}
        loading="lazy"
        onLoad={() => setLoaded(true)}
        className={cn(
          'mb-1 max-h-72 w-auto max-w-full rounded-lg object-contain transition-opacity duration-300',
          loaded ? 'opacity-100' : 'opacity-0',
        )}
      />
      {uploading && <UploadingOverlay />}
    </span>
  )
}

/** Telegram-style "still uploading" veil with a spinning ring over media. */
function UploadingOverlay() {
  return (
    <span className="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-black/35">
      <Loader2 className="size-7 animate-spin text-white/90" />
    </span>
  )
}

/** Inline media renderer: photos, video, voice/audio players, file cards. */
function MediaContent({ message, mine }: { message: Message; mine: boolean }) {
  const url = message.mediaUrl as string
  const uploading = message.status === 'pending'
  switch (message.mediaType) {
    case 'image':
    case 'sticker':
      return (
      <a href={url} target="_blank" rel="noreferrer" className="block">
        <ImageWithSkeleton
          url={url}
          alt={message.mediaName || 'Изображение'}
          uploading={uploading}
        />
      </a>
      )
    case 'video_note':
      // Телеграм-стиль кружок: круглый, клик = play/pause, прогресс-обод.
      return <VideoNotePlayer src={url} size={176} className="mb-1" />
    case 'video':
      return (
        <video
          src={url}
          controls
          preload="metadata"
          playsInline
          className="mb-1 max-h-72 w-auto max-w-full rounded-lg"
        />
      )
    case 'voice':
    case 'audio':
      return (
        <audio src={url} controls preload="metadata" className="mb-1 w-56 max-w-full" />
      )
    default:
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          download={message.mediaName || undefined}
          className={cn(
            'mb-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs underline-offset-2 hover:underline',
            mine ? 'bg-primary-foreground/10' : 'bg-muted',
          )}
        >
          <FileText className="size-4 shrink-0" />
          <span className="truncate">{message.mediaName || 'Файл'}</span>
        </a>
      )
  }
}

function mediaLabel(t?: string): string {
  switch (t) {
    case 'image':
      return 'Фото'
    case 'video':
    case 'video_note':
      return 'Видео'
    case 'voice':
      return 'Голосовое сообщение'
    case 'audio':
      return 'Аудио'
    case 'sticker':
      return 'Стикер'
    case 'document':
      return 'Файл'
    default:
      return 'Сообщение'
  }
}

/** Column count for a Telegram-style media album grid. */
function albumCols(n: number): string {
  if (n === 2) return 'grid-cols-2'
  if (n === 4) return 'grid-cols-2'
  return 'grid-cols-3'
}

/**
 * A run of photos/videos sent together, rendered as ONE Telegram-style album:
 * a tight square grid with a single caption + timestamp footer. Tap a cell to
 * open it; long-press (touch) or right-click (desktop) opens the action sheet
 * for that specific item, so per-photo reply/delete still works.
 */
export const MediaAlbumBubble = memo(function MediaAlbumBubble({
  messages,
  onReply,
  onMenu,
}: {
  messages: Message[]
  onReply: (message: Message) => void
  onMenu: (message: Message) => void
}) {
  const mine = messages[0].direction === 'in'
  const caption = messages.map((m) => parseReply(m.body).text).find(Boolean) || ''
  const last = messages[messages.length - 1]
  const cols = albumCols(messages.length)

  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pressFired = useRef(false)
  const startCellPress = (m: Message) => {
    pressFired.current = false
    pressTimer.current = setTimeout(() => {
      pressFired.current = true
      onMenu(m)
    }, LONG_PRESS_MS)
  }
  const clearCellPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  return (
    <div className={cn('flex px-1', mine ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[16rem] overflow-hidden rounded-2xl p-1',
          mine ? 'bg-primary' : 'bg-card border border-border',
        )}
      >
        <div className={cn('grid gap-[3px]', cols)}>
          {messages.map((m) => {
            const url = (m.mediaUrl as string) || '/placeholder.svg'
            const uploading = m.status === 'pending'
            const failed = m.status === 'failed'
            return (
              <a
                key={m.id}
                href={uploading ? undefined : url}
                target="_blank"
                rel="noreferrer"
                onContextMenu={(e) => {
                  e.preventDefault()
                  onMenu(m)
                }}
                onPointerDown={(e) => {
                  if (e.pointerType === 'touch') startCellPress(m)
                }}
                onPointerUp={clearCellPress}
                onPointerLeave={clearCellPress}
                onClick={(e) => {
                  if (pressFired.current) e.preventDefault()
                }}
                className="relative block aspect-square overflow-hidden rounded-md bg-muted/40"
              >
                {m.mediaType === 'video' ? (
                  // eslint-disable-next-line jsx-a11y/media-has-caption
                  <video
                    src={url}
                    muted
                    playsInline
                    preload="metadata"
                    className="size-full object-cover"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={url}
                    alt={m.mediaName || 'Изображение'}
                    loading="lazy"
                    className="size-full object-cover"
                  />
                )}
                {uploading && <UploadingOverlay />}
                {failed && (
                  <span className="absolute inset-0 z-10 flex items-center justify-center rounded-md bg-destructive/50 text-[10px] font-medium text-white">
                    Ошибка
                  </span>
                )}
              </a>
            )
          })}
        </div>
        {caption && (
          <p
            className={cn(
              'whitespace-pre-wrap break-words px-1.5 pt-1 text-sm leading-relaxed',
              mine ? 'text-primary-foreground' : 'text-foreground',
            )}
          >
            {caption}
          </p>
        )}
        <span
          className={cn(
            'flex items-center justify-end gap-1 px-1.5 pb-0.5 pt-0.5 text-[10px]',
            mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
          )}
        >
          {fmtTime(last.createdAt)}
          {mine &&
            (last.status === 'read' ? (
              <CheckCheck className="size-3" />
            ) : (
              <Check className="size-3" />
            ))}
        </span>
      </div>
    </div>
  )
})
