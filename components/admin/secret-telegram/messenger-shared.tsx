'use client'

/**
 * Общие утилиты и мелкие презентационные компоненты личного мессенджера
 * (god-панель, вкладка «Telegram»). Вынесено из personal-messenger.tsx.
 * Часть god-панели — инварианты AGENTS.md §4.
 */

import { useState } from 'react'
import { FileText, Users } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  PersonalDialog,
  PersonalMessage,
} from '@/app/actions/admin-secret/telegram-personal'

export function formatTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function formatDialogTime(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  }
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
}

export function dayLabel(ts: number): string {
  const d = new Date(ts * 1000)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) return 'Сегодня'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (d.toDateString() === yesterday.toDateString()) return 'Вчера'
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  })
}

export function mediaUrl(channelId: string, peer: string, messageId: string): string {
  const p = new URLSearchParams({ channelId, peer, messageId })
  return `/wijegniwjgwjog/api/personal-media?${p.toString()}`
}

export function avatarUrl(channelId: string, peer: string): string {
  const p = new URLSearchParams({ channelId, peer, avatar: '1' })
  return `/wijegniwjgwjog/api/personal-media?${p.toString()}`
}

/** Детерминированный оттенок для заглушки аватара. */
const AVATAR_HUES = [
  'bg-sky-600',
  'bg-emerald-600',
  'bg-violet-600',
  'bg-amber-600',
  'bg-rose-600',
  'bg-cyan-600',
]
export function avatarHue(peerId: string): string {
  let h = 0
  for (let i = 0; i < peerId.length; i++) h = (h * 31 + peerId.charCodeAt(i)) | 0
  return AVATAR_HUES[Math.abs(h) % AVATAR_HUES.length]
}

/* ------------------------------- Аватар --------------------------------- */

export function DialogAvatar({
  channelId,
  dialog,
  size = 'md',
}: {
  channelId: string
  dialog: PersonalDialog
  size?: 'md' | 'sm'
}) {
  const [failed, setFailed] = useState(false)
  const dim = size === 'md' ? 'size-11' : 'size-9'
  const initial = (dialog.title || '?').trim().charAt(0).toUpperCase()
  if (!dialog.hasAvatar || failed) {
    return (
      <div
        className={cn(
          'flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
          dim,
          avatarHue(dialog.peerId),
        )}
      >
        {dialog.kind === 'user' ? initial : <Users className="size-4" />}
      </div>
    )
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl(channelId, dialog.peerId) || "/placeholder.svg"}
      alt=""
      className={cn('shrink-0 rounded-full object-cover', dim)}
      onError={() => setFailed(true)}
    />
  )
}

/* ---------------------------- Медиа сообщения ---------------------------- */

export function MessageMediaBlock({
  channelId,
  peer,
  message,
}: {
  channelId: string
  peer: string
  message: PersonalMessage
}) {
  const url = mediaUrl(channelId, peer, message.id)
  switch (message.mediaType) {
    case 'image':
    case 'sticker':
      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url || "/placeholder.svg"}
          alt={message.mediaName ?? 'Изображение'}
          loading="lazy"
          className={cn(
            'max-h-72 rounded-lg object-contain',
            message.mediaType === 'sticker' ? 'max-w-36 bg-transparent' : 'max-w-full',
          )}
        />
      )
    case 'video':
    case 'video_note':
      return (
        <video
          src={url}
          controls
          preload="metadata"
          className={cn(
            'max-h-72 rounded-lg',
            message.mediaType === 'video_note' && 'aspect-square max-w-56 rounded-full',
          )}
        />
      )
    case 'voice':
    case 'audio':
      return <audio src={url} controls preload="none" className="h-10 w-60 max-w-full" />
    case 'document':
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-2 rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-sm hover:bg-background/70"
        >
          <FileText className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate">{message.mediaName ?? 'Файл'}</span>
        </a>
      )
    default:
      return null
  }
}
