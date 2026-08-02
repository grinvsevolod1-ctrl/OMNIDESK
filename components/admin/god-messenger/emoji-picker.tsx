'use client'

import { memo } from 'react'
import { Smile } from 'lucide-react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'

/**
 * Compact Telegram-style emoji palette for the god-messenger composer.
 * Static grid (no network, no heavy emoji-picker dependency) — tapping an
 * emoji inserts it into the draft and keeps the popover open for multi-insert.
 */
const EMOJI: string[] = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😜',
  '🤔', '🙃', '😉', '😎', '🥰', '😢', '😭', '😡',
  '😱', '🤯', '🥳', '🤝', '👍', '👎', '👌', '✌️',
  '🙏', '💪', '👏', '🤦', '🤷', '👋', '❤️', '🔥',
  '⭐', '🎉', '✅', '❌', '⚡', '💡', '💰', '📞',
  '📦', '🕐', '🚀', '🍀', '☕', '🌟', '💬', '😴',
]

export const EmojiPicker = memo(function EmojiPicker({
  onPick,
}: {
  onPick: (emoji: string) => void
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          aria-label="Эмодзи"
        >
          <Smile className="size-5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-64 p-2"
      >
        <div className="grid grid-cols-8 gap-0.5">
          {EMOJI.map((e) => (
            <button
              key={e}
              type="button"
              onClick={() => onPick(e)}
              className="flex size-7 items-center justify-center rounded-md text-lg leading-none transition-colors hover:bg-muted"
              aria-label={`Эмодзи ${e}`}
            >
              {e}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
})
