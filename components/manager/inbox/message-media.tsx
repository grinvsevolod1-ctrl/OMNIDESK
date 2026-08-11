'use client'

/**
 * Message media rendering extracted from the inbox-view monolith: placeholder
 * detection, filename/blob-download helpers, the fullscreen lightbox, and the
 * per-message <MessageMedia> renderer. Pure/presentational — driven entirely by
 * the Message it's handed, with only local view state (failed/lightbox).
 */

import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Download, ExternalLink, FileText, Info, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { TgsSticker } from '@/components/manager/inbox/tgs-sticker'
import type { Message } from '@/lib/types'

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
 * Fullscreen viewer for an image or video, with download + open-in-new-tab.
 * Rendered as a fixed overlay (only one is ever open per message bubble).
 */
function MediaLightbox({
  message,
  onClose,
}: {
  message: Message
  onClose: () => void
}) {
  const url = message.mediaUrl
  const effType = effectiveMediaType(message)
  const isVideo = effType === 'video' || effType === 'video_note'

  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!url) return null

  // Message rows use `content-visibility: auto`, which creates a containment
  // context that BREAKS position:fixed descendants (the overlay ends up
  // offset inside the bubble instead of covering the screen). Portaling to
  // document.body restores true fullscreen positioning.
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр вложения"
      className="fixed inset-0 z-[100] flex flex-col bg-black/90 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div className="flex shrink-0 items-center justify-end gap-2 p-3">
        <Button
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            void downloadMedia(url, mediaFilename(message))
          }}
        >
          <Download className="size-4" />
          Скачать
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={(e) => {
            e.stopPropagation()
            window.open(url, '_blank', 'noopener,noreferrer')
          }}
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
      <div
        className="flex min-h-0 flex-1 items-center justify-center p-4 animate-in zoom-in-95 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {isVideo ? (
          <video
            src={url}
            controls
            autoPlay
            className={
              effType === 'video_note'
                ? 'aspect-square max-h-full max-w-full rounded-full object-cover'
                : 'max-h-full max-w-full rounded-lg'
            }
          />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={url || '/placeholder.svg'}
            alt={message.body || 'Изображение'}
            className="max-h-full max-w-full rounded-lg object-contain"
          />
        )}
      </div>
    </div>,
    document.body,
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
  const url = message.mediaUrl
  const type = effectiveMediaType(message)

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
          onClick={() => setLightbox(true)}
          className="group relative block cursor-zoom-in overflow-hidden rounded-lg"
          aria-label="Открыть изображение"
        >
          {/* External chat media of unknown size — see note above; plain img. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url || '/placeholder.svg'}
            alt={message.body || 'Изображение'}
            className="max-h-80 max-w-full rounded-lg object-contain"
            loading="lazy"
            onError={() => setFailed(true)}
          />
        </button>
        {lightbox ? (
          <MediaLightbox message={message} onClose={() => setLightbox(false)} />
        ) : null}
      </>
    )
  }

  if (type === 'video_note') {
    return (
      <>
        <button
          type="button"
          onClick={() => setLightbox(true)}
          className="block cursor-zoom-in rounded-full"
          aria-label="Открыть видео"
        >
          <video
            src={url}
            className="pointer-events-none size-48 rounded-full object-cover"
            onError={() => setFailed(true)}
          />
        </button>
        {lightbox ? (
          <MediaLightbox message={message} onClose={() => setLightbox(false)} />
        ) : null}
      </>
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
            onClick={() => setLightbox(true)}
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
        {lightbox ? (
          <MediaLightbox message={message} onClose={() => setLightbox(false)} />
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
