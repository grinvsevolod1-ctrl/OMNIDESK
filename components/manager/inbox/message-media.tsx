'use client'

/**
 * Message media rendering extracted from the inbox-view monolith: placeholder
 * detection, filename/blob-download helpers, the fullscreen lightbox, and the
 * per-message <MessageMedia> renderer. Pure/presentational — driven entirely by
 * the Message it's handed, with only local view state (failed/lightbox).
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
import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  FileText,
  Info,
  Play,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { TgsSticker } from '@/components/manager/inbox/tgs-sticker'
import { VideoNotePlayer } from '@/components/shared/video-note-player'
import type { Message } from '@/lib/types'
import { cn } from '@/lib/utils'

/** Placeholder labels we synthesise at ingest for media without a caption. */
const MEDIA_PLACEHOLDERS = new Set([
  '[Фото]',
  '[Видео]',
  '[Видеосообщение]',
  '[Голосовое сообщение]',
  '[Аудио]',
  '[Стикер]',
  '[Файл]',
  '[Документ]',
])

/** True when `body` is just a synthetic media placeholder (so we hide it). */
export function isMediaPlaceholder(body: string): boolean {
  const b = body.trim()
  if (MEDIA_PLACEHOLDERS.has(b)) return true
  if (b.startsWith('[Файл:') || b.startsWith('[Стикер]')) return true
  // Sticker placeholders may be "😀 [Стикер]".
  if (b.endsWith('[Стикер]')) return true
  return false
}

/**
 * Force-download a media file rather than navigating to it. The bytes are
 * same-origin (`/api/media/{id}`), so we fetch them as a blob and click a
 * temporary anchor with a `download` attribute — this works even when the
 * server streams the file `inline`, and lets us set a sensible filename.
 */
async function downloadMedia(url: string, filename: string): Promise<void> {
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
 * Effective media type with defensive re-typing for historical rows:
 * telegram «кружки» ingested before video_note support were stored as
 * voice/audio while keeping their video/* MIME.
 */
function effectiveMediaType(message: Message): Message['mediaType'] {
  const t = message.mediaType
  if (
    (t === 'voice' || t === 'audio') &&
    message.mediaMime?.startsWith('video/')
  ) {
    return 'video_note'
  }
  return t
}

/** Suggest a filename for a downloaded media item from its type/name. */
function mediaFilename(message: Message): string {
  if (message.mediaName) return message.mediaName
  const ext =
    message.mediaType === 'image'
      ? 'jpg'
      : message.mediaType === 'video' || message.mediaType === 'video_note'
        ? 'mp4'
        : message.mediaType === 'voice' || message.mediaType === 'audio'
          ? 'ogg'
          : 'bin'
  return `media-${message.id.slice(0, 8)}.${ext}`
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
function MediaLightbox({
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

/** A viewable media item is an image/video/«кружок» with a streamable URL. */
function isGalleryMedia(m: Message): boolean {
  if (!m.mediaUrl) return false
  const t = effectiveMediaType(m)
  return t === 'image' || t === 'video' || t === 'video_note'
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

function useMediaGallery(): MediaGalleryValue | null {
  return useContext(MediaGalleryContext)
}

/**
 * Telegram-style album grid: several image/video messages sent together render
 * as one grid instead of a messy tall column of separate bubbles. Layout mirrors
 * Telegram: 2→two-up, 3→one wide over a pair, 4→2×2, 5+→three columns. Every
 * cell is a square crop that opens the SAME fullscreen lightbox used for single
 * media (so download / open-in-tab / safe-area insets all come for free).
 */
export function MessageMediaAlbum({ items }: { items: Message[] }) {
  const gallery = useMediaGallery()
  // Fallback gallery over just this album if no provider is present (defensive —
  // in the inbox MediaGalleryProvider always wraps the thread).
  const [localIndex, setLocalIndex] = useState<number | null>(null)
  const openCell = (m: Message) => {
    if (gallery) gallery.open(m.id)
    else setLocalIndex(items.findIndex((x) => x.id === m.id))
  }
  const n = items.length
  const cols = n <= 4 ? 2 : 3
  return (
    <>
      <div
        className={cn(
          'grid w-64 max-w-full gap-0.5 sm:w-72',
          cols === 2 ? 'grid-cols-2' : 'grid-cols-3',
        )}
      >
        {items.map((m, idx) => (
          <AlbumCell
            key={m.id}
            message={m}
            // 3-photo album: the first image spans the full width above the pair.
            className={n === 3 && idx === 0 ? 'col-span-2' : undefined}
            onOpen={() => openCell(m)}
          />
        ))}
      </div>
      {!gallery && localIndex !== null && items[localIndex] ? (
        <MediaLightbox
          items={items}
          index={localIndex}
          onIndexChange={setLocalIndex}
          onClose={() => setLocalIndex(null)}
        />
      ) : null}
    </>
  )
}

/** One square cell of a MessageMediaAlbum. */
function AlbumCell({
  message,
  className,
  onOpen,
}: {
  message: Message
  className?: string
  onOpen: () => void
}) {
  const [failed, setFailed] = useState(false)
  const url = message.mediaUrl
  const isVideo = effectiveMediaType(message) === 'video'
  if (!url || failed) {
    return (
      <div
        className={cn(
          'flex aspect-square items-center justify-center rounded-md bg-muted/60 text-muted-foreground',
          className,
        )}
      >
        <Info className="size-4" />
      </div>
    )
  }
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Открыть вложение"
      className={cn(
        'relative block aspect-square cursor-zoom-in overflow-hidden rounded-md bg-muted',
        className,
      )}
    >
      {isVideo ? (
        <>
          <video src={url} preload="metadata" className="size-full object-cover" />
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="rounded-full bg-black/45 p-2">
              <Play className="size-4 fill-white text-white" />
            </span>
          </span>
        </>
      ) : (
        // External chat media of unknown size — plain img (next/image can't
        // optimize arbitrary CDN sources); square-cropped to the cell.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url || '/placeholder.svg'}
          alt={message.mediaName || 'Вложение'}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onError={() => setFailed(true)}
        />
      )}
    </button>
  )
}

/**
 * Render a message's media. Streams bytes from `/api/media/{id}` via the panel
 * proxy. On error (e.g. expired WhatsApp media) falls back to a small notice.
 * Images and videos are clickable to open a fullscreen viewer where they can be
 * saved.
 */
export function MessageMedia({ message }: { message: Message }) {
  const [failed, setFailed] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const gallery = useMediaGallery()
  const url = message.mediaUrl
  const type = effectiveMediaType(message)
  // Открытие: если есть общий провайдер треда — листаемая галерея по всему
  // чату; иначе локальный одиночный лайтбокс (см. fallback ниже).
  const openViewer = () =>
    gallery ? gallery.open(message.id) : setLightbox(true)

  if (!type) return null

  // Stickers degrade to their emoji when there's no streamable URL (e.g. our
  // own optimistic outgoing sticker) or when the download fails.
  if (type === 'sticker' && (!url || failed)) {
    return <span className="text-5xl leading-none">{message.body || '🎯'}</span>
  }

  if (!url) return null

  if (failed) {
    return (
      <div className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
        <Info className="size-3.5 shrink-0" />
        Медиа недоступно
      </div>
    )
  }

  if (type === 'sticker') {
    // Telegram stickers come in three containers, and only WEBP renders in an
    // <img> — TGS (gzipped Lottie) and WEBM (video) used to hit onError and
    // degrade to the "[Стикер]" text. Dispatch on the stored mime, with a
    // magic-bytes-honest fallback already applied worker-side.
    const mime = message.mediaMime || ''
    if (mime.includes('tgs') || mime === 'application/gzip') {
      return (
        <TgsSticker
          url={url}
          alt={message.body || '🎯'}
          onError={() => setFailed(true)}
        />
      )
    }
    if (mime.startsWith('video/')) {
      return (
        <video
          src={url}
          autoPlay
          loop
          muted
          playsInline
          className="size-32 object-contain"
          aria-label={message.body || 'Стикер'}
          onError={() => setFailed(true)}
        />
      )
    }
    return (
      // Chat media comes from arbitrary external CDNs (Telegram/VK/etc.) with
      // unknown dimensions; next/image can't optimize these, so a plain img is
      // the correct choice here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url || '/placeholder.svg'}
        alt={message.body || 'Стикер'}
        className="size-32 object-contain"
        loading="lazy"
        onError={() => setFailed(true)}
      />
    )
  }

  if (type === 'image') {
    return (
      <>
        <button
          type="button"
          onClick={openViewer}
          className={cn(
            'group relative block cursor-zoom-in overflow-hidden rounded-lg',
            // Пока картинка грузится — приглушённый фон с «шиммером», чтобы не
            // было пустого прыжка (как превью-заглушка в Telegram).
            !imgLoaded && 'min-h-40 min-w-40 skeleton-shimmer bg-muted/60',
          )}
          aria-label="Открыть изображение"
        >
          {/* External chat media of unknown size — see note above; plain img. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url || '/placeholder.svg'}
            alt={message.body || 'Изображение'}
            className={cn(
              'max-h-80 max-w-full rounded-lg object-contain transition-opacity duration-300',
              imgLoaded ? 'opacity-100' : 'opacity-0',
            )}
            loading="lazy"
            decoding="async"
            onLoad={() => setImgLoaded(true)}
            onError={() => setFailed(true)}
          />
        </button>
        {lightbox && !gallery ? (
          <MediaLightbox
            items={[message]}
            index={0}
            onIndexChange={() => {}}
            onClose={() => setLightbox(false)}
          />
        ) : null}
      </>
    )
  }

  if (type === 'video_note') {
    // Телеграм-стиль кружок: play/pause по клику, круговой прогресс-обод,
    // оставшееся время внутри. Скачивание — маленькой кнопкой под кружком.
    return (
      <div className="flex flex-col gap-1">
        <VideoNotePlayer
          src={url}
          size={192}
          onError={() => setFailed(true)}
        />
        <button
          type="button"
          onClick={() => void downloadMedia(url, mediaFilename(message))}
          className="flex items-center gap-1 self-center text-xs opacity-70 hover:opacity-100"
        >
          <Download className="size-3.5" />
          Скачать
        </button>
      </div>
    )
  }

  if (type === 'video') {
    return (
      <div className="flex flex-col gap-1">
        <video
          src={url}
          controls
          className="max-h-80 max-w-full rounded-lg"
          onError={() => setFailed(true)}
        />
        <div className="flex items-center gap-3 text-xs">
          <button
            type="button"
            onClick={openViewer}
            className="flex items-center gap-1 opacity-70 hover:opacity-100"
          >
            <ExternalLink className="size-3.5" />
            Открыть
          </button>
          <button
            type="button"
            onClick={() => void downloadMedia(url, mediaFilename(message))}
            className="flex items-center gap-1 opacity-70 hover:opacity-100"
          >
            <Download className="size-3.5" />
            Скачать
          </button>
        </div>
        {lightbox && !gallery ? (
          <MediaLightbox
            items={[message]}
            index={0}
            onIndexChange={() => {}}
            onClose={() => setLightbox(false)}
          />
        ) : null}
      </div>
    )
  }

  if (type === 'voice' || type === 'audio') {
    return (
      <div className="flex flex-col gap-1">
        <audio
          src={url}
          controls
          className="w-56 max-w-full"
          onError={() => setFailed(true)}
        />
        <button
          type="button"
          onClick={() => void downloadMedia(url, mediaFilename(message))}
          className="flex items-center gap-1 text-xs opacity-70 hover:opacity-100"
        >
          <Download className="size-3.5" />
          Скачать
        </button>
      </div>
    )
  }

  // document
  return (
    <button
      type="button"
      onClick={() => void downloadMedia(url, mediaFilename(message))}
      className="flex items-center gap-2 rounded-lg bg-muted/60 px-3 py-2 text-xs font-medium hover:bg-muted"
    >
      <FileText className="size-4 shrink-0" />
      <span className="truncate">{message.mediaName || 'Файл'}</span>
      <Download className="size-3.5 shrink-0 opacity-70" />
    </button>
  )
}
