'use client'

/**
 * What a message's media looks like IN the bubble: placeholder detection, the
 * album grid, one album cell, and the per-message <MessageMedia> tile. Pure /
 * presentational — driven by the Message it's handed. The fullscreen viewer
 * lives in media-lightbox.tsx, the retry/stall logic in
 * use-retrying-media-src.ts; this file only composes them.
 */

import { memo, useState } from 'react'
import { Download, ExternalLink, FileText, Info, Play } from 'lucide-react'
import { TgsSticker } from '@/components/manager/inbox/tgs-sticker'
import {
  SelectionBadge,
  useTileSelection,
} from '@/components/manager/inbox/media-selection'
import {
  MediaLightbox,
  downloadMedia,
  useMediaGallery,
} from '@/components/manager/inbox/media-lightbox'
import { useRetryingMediaSrc } from '@/components/manager/inbox/use-retrying-media-src'
import { VideoNotePlayer } from '@/components/shared/video-note-player'
import type { Message } from '@/lib/types'
import { cn } from '@/lib/utils'
import { effectiveMediaType } from '@/lib/media-albums'
import { mediaFilename } from '@/lib/media-download'

export { MediaGalleryProvider } from '@/components/manager/inbox/media-lightbox'

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
 * Telegram-style album grid: several image/video messages sent together render
 * as one grid instead of a messy tall column of separate bubbles. Layout mirrors
 * Telegram: 2→two-up, 3→one wide over a pair, 4→2×2, 5+→three columns. Every
 * cell is a square crop that opens the SAME fullscreen lightbox used for single
 * media (so download / open-in-tab / safe-area insets all come for free).
 */
function MessageMediaAlbumImpl({ items }: { items: Message[] }) {
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

/**
 * Memoized: the thread re-renders on every "typing…" tick / reply-jump
 * highlight / selection toggle. The album's `items` slice keeps a stable
 * reference across those passes (thread array unchanged), so memo skips the
 * whole grid re-render.
 */
export const MessageMediaAlbum = memo(MessageMediaAlbumImpl)

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
  const url = message.mediaUrl
  const { src, failed, onMediaError, onMediaSettled } =
    useRetryingMediaSrc(url)
  const isVideo = effectiveMediaType(message) === 'video'
  // Bulk selection mode: the cell toggles its checkmark instead of opening.
  const selection = useTileSelection(message)
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
      onClick={selection ? selection.onSelect : onOpen}
      aria-label={
        selection
          ? selection.selected
            ? 'Снять выбор'
            : 'Выбрать вложение'
          : 'Открыть вложение'
      }
      aria-pressed={selection ? selection.selected : undefined}
      className={cn(
        'relative block aspect-square overflow-hidden rounded-md bg-muted',
        selection ? 'cursor-pointer' : 'cursor-zoom-in',
        selection?.selected &&
          'ring-2 ring-primary ring-offset-1 ring-offset-background',
        className,
      )}
    >
      {selection ? <SelectionBadge selected={selection.selected} /> : null}
      {isVideo ? (
        <>
          <video
            src={src}
            preload="metadata"
            className="size-full object-cover"
            onLoadedMetadata={onMediaSettled}
            onError={onMediaError}
          />
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
          src={src || '/placeholder.svg'}
          alt={message.mediaName || 'Вложение'}
          loading="lazy"
          decoding="async"
          className="size-full object-cover"
          onLoad={onMediaSettled}
          onError={onMediaError}
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
function MessageMediaImpl({ message }: { message: Message }) {
  const [lightbox, setLightbox] = useState(false)
  const [imgLoaded, setImgLoaded] = useState(false)
  const gallery = useMediaGallery()
  const url = message.mediaUrl
  const { src, failed, onMediaError, onMediaSettled } =
    useRetryingMediaSrc(url)
  const type = effectiveMediaType(message)
  // Bulk selection mode (photos/videos only): tap toggles the checkmark.
  const selection = useTileSelection(message)
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
          url={src || url}
          alt={message.body || '🎯'}
          onLoad={onMediaSettled}
          onError={onMediaError}
        />
      )
    }
    if (mime.startsWith('video/')) {
      return (
        <video
          src={src}
          autoPlay
          loop
          muted
          playsInline
          className="size-32 object-contain"
          aria-label={message.body || 'Стикер'}
          onLoadedMetadata={onMediaSettled}
          onError={onMediaError}
        />
      )
    }
    return (
      // Chat media comes from arbitrary external CDNs (Telegram/VK/etc.) with
      // unknown dimensions; next/image can't optimize these, so a plain img is
      // the correct choice here.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src || '/placeholder.svg'}
        alt={message.body || 'Стикер'}
        className="size-32 object-contain"
        loading="lazy"
        onLoad={onMediaSettled}
        onError={onMediaError}
      />
    )
  }

  if (type === 'image') {
    return (
      <>
        <button
          type="button"
          onClick={selection ? selection.onSelect : openViewer}
          className={cn(
            'group relative block overflow-hidden rounded-lg',
            selection ? 'cursor-pointer' : 'cursor-zoom-in',
            selection?.selected &&
              'ring-2 ring-primary ring-offset-2 ring-offset-background',
            // Пока картинка грузится — приглушённый фон с «шиммером», чтобы не
            // было пустого прыжка (как превью-заглушка в Telegram).
            !imgLoaded && 'min-h-40 min-w-40 skeleton-shimmer bg-muted/60',
          )}
          aria-label={
            selection
              ? selection.selected
                ? 'Снять выбор'
                : 'Выбрать изображение'
              : 'Открыть изображение'
          }
          aria-pressed={selection ? selection.selected : undefined}
        >
          {selection ? <SelectionBadge selected={selection.selected} /> : null}
          {/* External chat media of unknown size — see note above; plain img. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src || '/placeholder.svg'}
            alt={message.body || 'Изображение'}
            className={cn(
              'max-h-80 max-w-full rounded-lg object-contain transition-opacity duration-300',
              imgLoaded ? 'opacity-100' : 'opacity-0',
            )}
            loading="lazy"
            decoding="async"
            onLoad={() => {
              onMediaSettled()
              setImgLoaded(true)
            }}
            onError={onMediaError}
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
          src={src || url}
          size={192}
          onLoadedMetadata={onMediaSettled}
          onError={onMediaError}
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
        <div
          className={cn(
            'relative',
            selection?.selected &&
              'rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background',
          )}
        >
          <video
            src={src}
            controls={!selection}
            className="max-h-80 max-w-full rounded-lg"
            onLoadedMetadata={onMediaSettled}
            onError={onMediaError}
          />
          {selection ? (
            // Selection mode: a full-size hit target over the player so a tap
            // toggles the checkmark instead of scrubbing the video.
            <button
              type="button"
              onClick={selection.onSelect}
              aria-label={selection.selected ? 'Снять выбор' : 'Выбрать видео'}
              aria-pressed={selection.selected}
              className="absolute inset-0 rounded-lg"
            >
              <SelectionBadge selected={selection.selected} />
            </button>
          ) : null}
        </div>
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
          src={src}
          controls
          className="w-56 max-w-full"
          onLoadedMetadata={onMediaSettled}
          onError={onMediaError}
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

/**
 * Memoized: the message list re-renders on every "typing…" tick, reply-jump
 * highlight and selection toggle. The `message` object keeps a stable
 * reference across those passes (the thread array is unchanged), so memo skips
 * re-rendering the media tile — the expensive part being sticker/video/img.
 */
export const MessageMedia = memo(MessageMediaImpl)
