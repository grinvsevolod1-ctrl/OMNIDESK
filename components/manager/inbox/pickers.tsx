'use client'

/**
 * Composer popovers extracted from the inbox-view monolith: an emoji picker and
 * a Telegram sticker picker. Both are pure/props-driven — they take callbacks
 * (onPick/onSend) and own only local popover/SWR state, so they carry no inbox
 * business logic.
 */

import { useState } from 'react'
import useSWR from 'swr'
import { Loader2, Smile, Sticker } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import type { StickerItem } from '@/lib/types'

const EMOJI_CATEGORIES: { label: string; emojis: string[] }[] = [
  {
    label: 'Смайлы',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇',
      '🙂', '🙃', '😉', '😌', '😍', '🥰', '😘', '😋', '😎', '🤩',
      '🥳', '😏', '😢', '😭', '😤', '😠', '😡', '🤔', '🤗', '🤭',
      '😴', '😬', '🙄', '😱', '😳', '🤯', '😅', '😢',
    ],
  },
  {
    label: 'Жесты',
    emojis: [
      '👍', '👎', '👌', '✌️', '🤞', '🤝', '👏', '🙏', '💪', '🫶',
      '👋', '🤙', '✋', '🖐️', '👊', '🤛', '🤜', '☝️', '👆', '👉',
    ],
  },
  {
    label: 'Сердца',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '💔', '❣️',
      '💕', '💞', '💓', '💗', '💖', '💘', '💝', '🔥', '⭐', '💯',
    ],
  },
  {
    label: 'Объекты',
    emojis: [
      '🎉', '🎊', '🎁', '🏆', '✅', '❌', '⚡', '💡', '📌', '📎',
      '💰', '📞', '📧', '📅', '⏰', '🚀', '👀', '💬', '❓', '❗',
    ],
  },
]

/** Emoji picker popover. Inserts the chosen emoji into the composer draft. */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-full text-muted-foreground"
            aria-label="Эмодзи"
          >
            <Smile className="size-5" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72 p-2">
        <div className="scrollbar-thin max-h-64 overflow-y-auto">
          {EMOJI_CATEGORIES.map((cat) => (
            <div key={cat.label} className="mb-2 last:mb-0">
              <p className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {cat.label}
              </p>
              <div className="grid grid-cols-8 gap-0.5">
                {cat.emojis.map((e, i) => (
                  <button
                    key={`${e}-${i}`}
                    type="button"
                    onClick={() => onPick(e)}
                    className="flex size-8 items-center justify-center rounded-md text-xl leading-none hover:bg-muted"
                    aria-label={`Вставить ${e}`}
                  >
                    {e}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Sticker picker (Telegram only). Lazily fetches the account's sticker palette
 * from `/api/stickers` the first time it opens, renders thumbnails, and sends
 * the chosen sticker on click.
 */
export function StickerPicker({
  channelId,
  onSend,
}: {
  channelId: string
  onSend: (sticker: StickerItem) => void
}) {
  const [open, setOpen] = useState(false)

  // Lazy-load the channel's sticker set only once the picker is opened, and let
  // SWR cache/dedupe it so reopening (or switching back to a channel) is instant
  // and never re-fetches. `key = null` keeps the request idle until `open`.
  const { data: stickers, isLoading: loading } = useSWR(
    open ? `/api/stickers?channelId=${encodeURIComponent(channelId)}` : null,
    (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : { stickers: [] }))
        .then((data: { stickers: StickerItem[] }) => data.stickers ?? [])
        .catch(() => [] as StickerItem[]),
    { revalidateOnFocus: false },
  )

  function thumbUrl(s: StickerItem): string {
    const qs = new URLSearchParams({
      channelId,
      id: s.id,
      accessHash: s.accessHash,
      fileReference: s.fileReference,
    })
    return `/api/stickers/thumb?${qs.toString()}`
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-full text-muted-foreground"
            aria-label="Стикеры"
          >
            <Sticker className="size-5" />
          </Button>
        }
      />
      <PopoverContent align="start" className="w-72 p-2">
        {loading ? (
          <div className="flex h-32 items-center justify-center">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : !stickers || stickers.length === 0 ? (
          <p className="px-2 py-8 text-center text-xs text-muted-foreground">
            Нет доступных стикеров. Добавьте стикеры в избранное в Telegram, и
            они появятся здесь.
          </p>
        ) : (
          <div className="scrollbar-thin grid max-h-64 grid-cols-4 gap-1 overflow-y-auto">
            {stickers.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  onSend(s)
                  setOpen(false)
                }}
                className="flex aspect-square items-center justify-center rounded-md p-1 hover:bg-muted"
                aria-label={s.emoji ? `Стикер ${s.emoji}` : 'Стикер'}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={thumbUrl(s) || '/placeholder.svg'}
                  alt={s.emoji || 'Стикер'}
                  className="size-full object-contain"
                  loading="lazy"
                />
              </button>
            ))}
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
