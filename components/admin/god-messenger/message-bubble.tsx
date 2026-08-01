'use client'

import {
  memo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'
import { Check, CheckCheck, CornerUpLeft } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'
import { fmtDay, fmtTime } from './utils'
import { parseReply } from './reply'

/* Swipe-left-to-reply thresholds (single bubble). */
const DRAG_MAX = 84
const DRAG_TRIGGER = 56

/**
 * One message. Perspective is inverted vs. the manager inbox: an INBOUND message
 * (direction 'in') is what the god typed AS THE CLIENT, so it sits on the RIGHT
 * as "mine"; an OUTBOUND message (direction 'out') is the manager's reply, shown
 * on the LEFT as "theirs". Swipe a bubble left (like Telegram) to reply to it.
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  prev,
  onReply,
}: {
  message: Message
  prev?: Message
  onReply: (message: Message) => void
}) {
  const mine = message.direction === 'in'
  const { quote, text } = parseReply(message.body)

  const [dragX, setDragX] = useState(0)
  const [dragging, setDragging] = useState(false)
  const startX = useRef(0)
  const startY = useRef(0)
  const axis = useRef<null | 'h' | 'v'>(null)

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    startX.current = e.clientX
    startY.current = e.clientY
    axis.current = null
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (startX.current === 0 && startY.current === 0) return
    const dx = e.clientX - startX.current
    const dy = e.clientY - startY.current
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
      // Swipe left to reply; clamp and add a little resistance past the trigger.
      const next = Math.max(-DRAG_MAX, Math.min(0, dx))
      setDragX(next)
    }
  }

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (axis.current === 'h') {
      if (dragX <= -DRAG_TRIGGER) onReply(message)
      try {
        e.currentTarget.releasePointerCapture(e.pointerId)
      } catch {
        /* ignore */
      }
    }
    startX.current = 0
    startY.current = 0
    axis.current = null
    setDragging(false)
    setDragX(0)
  }

  // Day separator when the calendar day changes.
  const showDay =
    !prev ||
    new Date(prev.createdAt).toDateString() !==
      new Date(message.createdAt).toDateString()

  const revealProgress = Math.min(1, -dragX / DRAG_TRIGGER)

  return (
    <>
      {showDay && (
        <div className="flex justify-center py-2">
          <span className="rounded-full bg-muted px-3 py-0.5 text-[11px] text-muted-foreground">
            {fmtDay(message.createdAt).split(' ')[0]}
          </span>
        </div>
      )}
      <div
        className="relative select-none"
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
              'max-w-[82%] rounded-2xl px-3.5 py-2 text-sm shadow-sm sm:max-w-[75%]',
              mine
                ? 'rounded-br-md bg-primary text-primary-foreground'
                : 'rounded-bl-md bg-card text-card-foreground',
            )}
          >
            {quote && (
              <div
                className={cn(
                  'mb-1 rounded-md border-l-2 px-2 py-1 text-xs',
                  mine
                    ? 'border-primary-foreground/50 bg-primary-foreground/10 text-primary-foreground/80'
                    : 'border-primary/50 bg-muted text-muted-foreground',
                )}
              >
                <span className="line-clamp-2 break-words">{quote}</span>
              </div>
            )}
            <p className="whitespace-pre-wrap break-words leading-relaxed">{text}</p>
            <span
              className={cn(
                'mt-0.5 flex items-center justify-end gap-1 text-[10px]',
                mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
              )}
            >
              {fmtTime(message.createdAt)}
              {mine &&
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
