'use client'

/**
 * Fullscreen media gallery for the thread: the lightbox itself, one slide per
 * media kind, and the conversation-wide gallery context that lets any
 * thumbnail open the viewer positioned on itself. Split out of
 * message-media.tsx so the tiles (what renders IN the bubble) and the viewer
 * (what opens OVER the screen) evolve independently.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { VideoNotePlayer } from '@/components/shared/video-note-player'
import type { Message } from '@/lib/types'
import { effectiveMediaType, isGalleryMedia } from '@/lib/media-albums'
import { mediaFilename } from '@/lib/media-download'

/**
 * Force-download a media file rather than navigating to it. The bytes are
 * same-origin (`/api/media/{id}`), so we fetch them as a blob and click a
 * temporary anchor with a `download` attribute — this works even when the
 * server streams the file `inline`, and lets us set a sensible filename.
 */
export async function downloadMedia(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`status ${res.status}`)
    const blob = await res.blob()
    const objectUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objectUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke a tick later so the download has a chance to start.
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch {
    // Fall back to opening in a new tab so the user can still save manually.
    window.open(url, '_blank', 'noopener,noreferrer')
    toast.error('Не удалось скачать файл — открыли в новой вкладке')
  }
}



/**
 * Fullscreen gallery viewer. Shows one media item from `items` at a time and
 * lets you move through the WHOLE conversation like Telegram: swipe left/right
 * (touch), ← / → keys, or the on-screen chevrons; a swipe DOWN closes. A counter
 * shows position; Download / Open always act on the CURRENT item.
 *
 * Rendered as a portal to <body> because message rows use `content-visibility`,
 * a containment context that breaks position:fixed descendants (the overlay
 * would otherwise offset inside the bubble instead of covering the screen).
 */
export function MediaLightbox({
  items,
  index,
  onIndexChange,
  onClose,
}: {
  items: Message[]
  index: number
  onIndexChange: (next: number) => void
  onClose: () => void
}) {
  const current = items[index]
  const hasPrev = index > 0
  const hasNext = index < items.length - 1
  const goPrev = useCallback(() => {
    if (index > 0) onIndexChange(index - 1)
  }, [index, onIndexChange])
  const goNext = useCallback(() => {
    if (index < items.length - 1) onIndexChange(index + 1)
  }, [index, items.length, onIndexChange])

  // Keyboard: Esc closes, ← / → navigate.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowLeft') goPrev()
      else if (e.key === 'ArrowRight') goNext()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext])

  // Плавное листание как в Telegram: горизонтальный слайд-трек. Палец ведёт
  // текущий кадр в реальном времени, на отпускании — инерционная доводка к
  // соседнему; свайп вниз закрывает. Смещение в пикселях от измеренной ширины
  // сцены (stageW), поэтому трек едет ровно на один кадр.
  const stageRef = useRef<HTMLDivElement>(null)
  const [stageW, setStageW] = useState(0)
  const [ready, setReady] = useState(false)
  const [drag, setDrag] = useState(0)
  const [dragging, setDragging] = useState(false)
  const touch = useRef<{ x: number; y: number; axis: '' | 'x' | 'y' } | null>(
    null,
  )

  // Замер ДО отрисовки (useLayoutEffect), чтобы при открытии не на первом кадре
  // трек сразу встал на нужный слайд без «прыжка». Анимацию включаем следующим
  // кадром — тогда переходы между кадрами уже плавные.
  useLayoutEffect(() => {
    const measure = () => setStageW(stageRef.current?.clientWidth ?? 0)
    measure()
    const raf = requestAnimationFrame(() => setReady(true))
    window.addEventListener('resize', measure)
    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', measure)
    }
  }, [])

  if (!current) return null
  const url = current.mediaUrl
  if (!url) return null

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр вложения"
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 animate-in fade-in duration-200"
      onClick={onClose}
    >
      {/* Тулбар прижат к верху фикс-оверлея: в standalone-PWA верх экрана
          занят статус-баром / Dynamic Island, поэтому добавляем safe-area
          отступы (top/left/right) — иначе кнопки уезжают под системную строку. */}
      <div
        className="flex shrink-0 items-center gap-2 p-3"
        style={{
          paddingTop: 'max(0.75rem, env(safe-area-inset-top))',
          paddingRight: 'max(0.75rem, env(safe-area-inset-right))',
          paddingLeft: 'max(0.75rem, env(safe-area-inset-left))',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {items.length > 1 ? (
          <span className="rounded-full bg-white/10 px-2.5 py-1 text-xs font-medium tabular-nums text-white/90">
            {index + 1} / {items.length}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void downloadMedia(url, mediaFilename(current))}
          >
            <Download className="size-4" />
            Скачать
          </Button>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => window.open(url, '_blank', 'noopener,noreferrer')}
          >
            <ExternalLink className="size-4" />
            Открыть
          </Button>
          <Button
            variant="secondary"
            size="icon"
            aria-label="Закрыть"
            onClick={onClose}
          >
            <X className="size-4" />
          </Button>
        </div>
      </div>

      {/* Сцена-слайдер: клик по пустому фону закрывает; трек с кадрами едет по
          горизонтали, overflow-hidden прячет соседние. */}
      <div
        ref={stageRef}
        className="relative min-h-0 flex-1 overflow-hidden"
        onClick={onClose}
        onTouchStart={(e) => {
          touch.current = {
            x: e.touches[0].clientX,
            y: e.touches[0].clientY,
            axis: '',
          }
          setDragging(true)
        }}
        onTouchMove={(e) => {
          const t = touch.current
          if (!t) return
          const dX = e.touches[0].clientX - t.x
          const dY = e.touches[0].clientY - t.y
          // Ось жеста фиксируем один раз: горизонталь — листаем, вертикаль —
          // готовим закрытие свайпом вниз.
          if (t.axis === '') {
            if (Math.abs(dX) > 8 || Math.abs(dY) > 8)
              t.axis = Math.abs(dX) > Math.abs(dY) ? 'x' : 'y'
          }
          if (t.axis === 'x') {
            // Резина на крайних кадрах, чтобы было понятно, что дальше некуда.
            let d = dX
            if ((index === 0 && d > 0) || (index === items.length - 1 && d < 0))
              d *= 0.35
            setDrag(d)
          }
        }}
        onTouchEnd={(e) => {
          const t = touch.current
          touch.current = null
          setDragging(false)
          if (!t) {
            setDrag(0)
            return
          }
          const dX = e.changedTouches[0].clientX - t.x
          const dY = e.changedTouches[0].clientY - t.y
          if (t.axis === 'y' && dY > 90) {
            onClose()
            setDrag(0)
            return
          }
          const threshold = Math.max(48, (stageW || 320) * 0.18)
          if (t.axis === 'x' && Math.abs(dX) > threshold) {
            if (dX < 0) goNext()
            else goPrev()
          }
          setDrag(0)
        }}
      >
        {hasPrev ? (
          <button
            type="button"
            aria-label="Предыдущее"
            onClick={(e) => {
              e.stopPropagation()
              goPrev()
            }}
            className="absolute left-2 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:block"
          >
            <ChevronLeft className="size-6" />
          </button>
        ) : null}
        {hasNext ? (
          <button
            type="button"
            aria-label="Следующее"
            onClick={(e) => {
              e.stopPropagation()
              goNext()
            }}
            className="absolute right-2 top-1/2 z-10 hidden -translate-y-1/2 rounded-full bg-white/10 p-2 text-white transition-colors hover:bg-white/20 sm:block"
          >
            <ChevronRight className="size-6" />
          </button>
        ) : null}

        {/* Трек шириной во все кадры; сдвиг = -index кадров + палец. Анимация
            transform с «мягкой» кривой даёт быструю плавную доводку. */}
        <div
          className="flex h-full"
          style={{
            transform: `translate3d(${-index * stageW + drag}px, 0, 0)`,
            transition:
              dragging || !ready
                ? 'none'
                : 'transform 0.3s cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {items.map((it, i) => (
            <div
              key={it.id}
              className="flex h-full shrink-0 items-center justify-center p-4"
              style={{ width: stageW || '100%' }}
              onClick={(e) => e.stopPropagation()}
            >
              {/* Держим в DOM только текущий и соседей — экономим память и не
                  тянем все видео/фото чата разом. */}
              {Math.abs(i - index) <= 1 ? (
                <GallerySlide message={it} active={i === index} />
              ) : null}
            </div>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  )
}

/** Один кадр слайдера: фото / видео / «кружок». Автоплей — только у активного. */
function GallerySlide({
  message,
  active,
}: {
  message: Message
  active: boolean
}) {
  const url = message.mediaUrl
  if (!url) return null
  const effType = effectiveMediaType(message)
  if (effType === 'video_note')
    return <VideoNotePlayer src={url} size={384} autoPlay={active} />
  if (effType === 'video')
    return (
      <video
        src={url}
        controls
        autoPlay={active}
        className="max-h-full max-w-full rounded-lg"
      />
    )
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url || '/placeholder.svg'}
      alt={message.body || 'Изображение'}
      className="max-h-full max-w-full select-none rounded-lg object-contain"
      draggable={false}
    />
  )
}

type MediaGalleryValue = { open: (messageId: string) => void }
const MediaGalleryContext = createContext<MediaGalleryValue | null>(null)

/**
 * Provides ONE conversation-wide media gallery to every media thumbnail beneath
 * it. Collects all viewable media in `messages` (thread order), so opening any
 * photo/video lets the user swipe through the entire chat, Telegram-style.
 * MessageMedia / album cells call `open(messageId)` instead of managing their
 * own single-item lightbox.
 */
export function MediaGalleryProvider({
  messages,
  children,
}: {
  messages: Message[]
  children: ReactNode
}) {
  const items = useMemo(() => messages.filter(isGalleryMedia), [messages])
  const [index, setIndex] = useState<number | null>(null)
  const open = useCallback(
    (messageId: string) => {
      const i = items.findIndex((m) => m.id === messageId)
      if (i >= 0) setIndex(i)
    },
    [items],
  )
  const value = useMemo(() => ({ open }), [open])
  return (
    <MediaGalleryContext.Provider value={value}>
      {children}
      {index !== null && items[index] ? (
        <MediaLightbox
          items={items}
          index={index}
          onIndexChange={setIndex}
          onClose={() => setIndex(null)}
        />
      ) : null}
    </MediaGalleryContext.Provider>
  )
}

export function useMediaGallery(): MediaGalleryValue | null {
  return useContext(MediaGalleryContext)
}
