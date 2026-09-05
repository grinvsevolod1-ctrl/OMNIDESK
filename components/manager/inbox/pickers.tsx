'use client'

/**
 * Composer popovers extracted from the inbox-view monolith: an emoji picker and
 * a Telegram sticker picker. Both are pure/props-driven — they take callbacks
 * (onPick/onSend) and own only local popover/SWR state, so they carry no inbox
 * business logic.
 */

import { memo, useCallback, useState } from 'react'
import useSWR from 'swr'
import {
  Car,
  Clock3,
  Dumbbell,
  Heart,
  Lightbulb,
  Loader2,
  PawPrint,
  Pizza,
  Shapes,
  Smile,
  Sticker,
  ThumbsUp,
  User,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import type { StickerItem } from '@/lib/types'
import { EMOJI_CATEGORIES } from './emoji-data'

/* ------------------------------ Emoji picker ------------------------------ */

const RECENT_KEY = 'omnidesk-recent-emojis'
const RECENT_MAX = 30

/**
 * Иконки вкладок категорий — lucide, а НЕ эмодзи-глифы. Раньше вкладки рисовали
 * сам эмодзи (`c.icon`): на части ОС (Windows/Linux) без нужного варианта VS16
 * они падали в монохромный текст-глиф и «ломались» вперемешку с цветными —
 * отсюда «иконки ебутся». Векторные lucide рендерятся одинаково везде.
 * Ключ — id категории из emoji-data; неизвестная категория падает на Smile.
 */
const CATEGORY_ICONS: Record<string, LucideIcon> = {
  smileys: Smile,
  gestures: ThumbsUp,
  people: User,
  hearts: Heart,
  animals: PawPrint,
  food: Pizza,
  activity: Dumbbell,
  travel: Car,
  objects: Lightbulb,
  symbols: Shapes,
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(arr)
      ? arr.filter((e): e is string => typeof e === 'string').slice(0, RECENT_MAX)
      : []
  } catch {
    return []
  }
}

function pushRecent(emoji: string): string[] {
  const next = [emoji, ...readRecent().filter((e) => e !== emoji)].slice(
    0,
    RECENT_MAX,
  )
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next))
  } catch {
    /* приватный режим — просто без «Недавних» */
  }
  return next
}

/**
 * Сетка одной категории. Мемоизирована и рендерится ТОЛЬКО для активной
 * вкладки — открытие пикера монтирует ~100 кнопок вместо ~1200, поэтому
 * попап открывается мгновенно даже на слабом железе.
 */
const EmojiGrid = memo(function EmojiGrid({
  emojis,
  onPick,
}: {
  emojis: string[]
  onPick: (emoji: string) => void
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5">
      {emojis.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          // content-visibility: браузер пропускает растеризацию цветных emoji-
          // глифов вне вьюпорта попапа (рисует ~видимые ряды, а не все 124–220
          // сразу) — именно эта покраска раньше вешала кадр при открытии.
          // contain-intrinsic-size = размер кнопки (size-9 = 2.25rem), чтобы
          // скролл не прыгал.
          style={{
            contentVisibility: 'auto',
            containIntrinsicSize: '2.25rem 2.25rem',
          }}
          className="flex size-9 items-center justify-center rounded-md text-xl leading-none transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          aria-label={`Вставить ${e}`}
        >
          {e}
        </button>
      ))}
    </div>
  )
})

/**
 * Эмодзи-пикер композера: данные импортируются СТАТИЧЕСКИ (палитра — всего
 * пара КБ строк-констант), поэтому попап открывается МГНОВЕННО — без
 * динамического import, без спиннера и без сброса при ремоунте композера
 * (раньше `key`-ремоунт на смену диалога обнулял categories и заставлял модуль
 * «грузиться» заново со спиннером на каждом открытии). «Недавние» читаются в
 * обработчике открытия, а не в эффекте, чтобы не плодить каскадные рендеры.
 */
export function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState('smileys')
  const [recent, setRecent] = useState<string[]>([])

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next)
    if (next) setRecent(readRecent())
  }, [])

  const handlePick = useCallback(
    (emoji: string) => {
      onPick(emoji)
      setRecent(pushRecent(emoji))
    },
    [onPick],
  )

  const activeEmojis =
    tab === 'recent'
      ? recent
      : (EMOJI_CATEGORIES.find((c) => c.id === tab)?.emojis ?? [])

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            aria-label="Эмодзи"
          >
            <Smile className="size-5" />
          </Button>
        }
      />
      <PopoverContent
        align="start"
        // Быстрый fade без зума: zoom-in-100 отменяет базовый zoom-in-95 (масштаб
        // остаётся 100%), duration-75 ускоряет появление — попап «выскакивает»
        // мгновенно, а не растягивается зумом на фоне тяжёлой покраски эмодзи.
        className="w-96 p-0 duration-75 data-open:zoom-in-100 data-closed:zoom-out-100"
      >
        <div className="flex h-72 flex-col" style={{ contain: 'content' }}>
          {/* Вкладки категорий */}
          <div
            className="scrollbar-thin flex items-center gap-0.5 overflow-x-auto border-b border-border px-1.5 py-1"
            role="tablist"
            aria-label="Категории эмодзи"
          >
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'recent'}
              onClick={() => setTab('recent')}
              className={cn(
                'flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
                tab === 'recent'
                  ? 'bg-muted text-foreground'
                  : 'text-muted-foreground hover:bg-muted/60',
              )}
              aria-label="Недавние"
              title="Недавние"
            >
              <Clock3 className="size-4" />
            </button>
            {EMOJI_CATEGORIES.map((c) => {
              const TabIcon = CATEGORY_ICONS[c.id] ?? Smile
              return (
                <button
                  key={c.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === c.id}
                  onClick={() => setTab(c.id)}
                  className={cn(
                    'flex size-7 shrink-0 items-center justify-center rounded-md transition-colors',
                    tab === c.id
                      ? 'bg-muted text-foreground'
                      : 'text-muted-foreground hover:bg-muted/60',
                  )}
                  aria-label={c.label}
                  title={c.label}
                >
                  <TabIcon className="size-4" />
                </button>
              )
            })}
          </div>

          {/* Сетка активной категории */}
          <div className="scrollbar-thin flex-1 overflow-y-auto p-2">
            {tab === 'recent' && recent.length === 0 ? (
              <p className="px-2 py-10 text-center text-xs text-muted-foreground">
                Здесь появятся эмодзи, которые вы используете чаще всего
              </p>
            ) : (
              <EmojiGrid emojis={activeEmojis} onPick={handlePick} />
            )}
          </div>
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
            className="size-9 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
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
