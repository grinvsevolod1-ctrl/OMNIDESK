'use client'

/**
 * Emoji + Telegram sticker content, extracted as pure grid PANELS (no popover
 * wrapper). They fill their container and are hosted by the right-docked
 * EmojiDock (см. emoji-dock.tsx) — Telegram-style: клик по смайлику открывает
 * панель справа вместо всплывашки над композером. Both are props-driven
 * (onPick/onSend) and own only local tab/SWR state — no inbox business logic.
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
  ThumbsUp,
  User,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { StickerItem } from '@/lib/types'
import { EMOJI_CATEGORIES } from './emoji-data'

/* ------------------------------ Emoji panel ------------------------------- */

const RECENT_KEY = 'omnidesk-recent-emojis'
const RECENT_MAX = 30

/**
 * Иконки вкладок категорий — lucide, а НЕ эмодзи-глифы. Раньше вкладки рисовали
 * сам эмодзи: на части ОС без нужного варианта VS16 они падали в монохромный
 * текст-глиф и «ломались» вперемешку с цветными. Векторные lucide рендерятся
 * одинаково везде. Ключ — id категории из emoji-data; неизвестная → Smile.
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
 * вкладки — переключение монтирует ~100 кнопок вместо ~1200, поэтому панель
 * отзывчива даже на слабом железе.
 */
const EmojiGrid = memo(function EmojiGrid({
  emojis,
  onPick,
}: {
  emojis: string[]
  onPick: (emoji: string) => void
}) {
  return (
    <div className="grid grid-cols-8 gap-0.5 sm:grid-cols-9">
      {emojis.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          // content-visibility: браузер пропускает растеризацию цветных emoji-
          // глифов вне вьюпорта (рисует ~видимые ряды, а не все сразу).
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
 * Панель эмодзи (без popover): вкладки категорий + сетка активной. Данные
 * статические (пара КБ строк-констант) — панель открывается мгновенно.
 * «Недавние» читаются лениво на маунте.
 */
export function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }) {
  const [tab, setTab] = useState('smileys')
  const [recent, setRecent] = useState<string[]>(() =>
    typeof window === 'undefined' ? [] : readRecent(),
  )

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
    <div className="flex h-full flex-col" style={{ contain: 'content' }}>
      {/* Вкладки категорий */}
      <div
        className="scrollbar-thin flex items-center gap-0.5 overflow-x-auto border-b border-border px-2 py-1.5"
        role="tablist"
        aria-label="Категории эмодзи"
      >
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'recent'}
          onClick={() => setTab('recent')}
          className={cn(
            'flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
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
                'flex size-8 shrink-0 items-center justify-center rounded-md transition-colors',
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
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-2.5">
        {tab === 'recent' && recent.length === 0 ? (
          <p className="px-2 py-12 text-center text-xs text-muted-foreground">
            Здесь появятся эмодзи, которые вы используете чаще всего
          </p>
        ) : (
          <EmojiGrid emojis={activeEmojis} onPick={handlePick} />
        )}
      </div>
    </div>
  )
}

/* ----------------------------- Sticker panel ------------------------------ */

/**
 * Панель стикеров (Telegram). Лениво тянет палитру аккаунта из `/api/stickers`
 * (избранное + недавние + популярные паки — см. воркер), кэширует через SWR,
 * шлёт выбранный стикер по клику. Панель НЕ закрывается после отправки —
 * можно кинуть несколько подряд, как в Telegram.
 */
export function StickerPanel({
  channelId,
  onSend,
}: {
  channelId: string
  onSend: (sticker: StickerItem) => void
}) {
  const { data: stickers, isLoading: loading } = useSWR(
    `/api/stickers?channelId=${encodeURIComponent(channelId)}`,
    (url: string) =>
      fetch(url)
        .then((r) => (r.ok ? r.json() : { stickers: [] }))
        .then((data: { stickers: StickerItem[] }) => data.stickers ?? [])
        .catch(() => [] as StickerItem[]),
    { revalidateOnFocus: false, dedupingInterval: 60_000 },
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

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!stickers || stickers.length === 0) {
    return (
      <p className="px-6 py-12 text-center text-xs text-muted-foreground">
        Стикеры не загрузились. Добавьте наборы или отдельные стикеры в
        избранное в Telegram — они появятся здесь автоматически.
      </p>
    )
  }

  return (
    <div className="scrollbar-thin grid h-full grid-cols-4 content-start gap-1.5 overflow-y-auto p-2.5 sm:grid-cols-5">
      {stickers.map((s) => (
        <button
          key={`${s.id}:${s.accessHash}`}
          type="button"
          onClick={() => onSend(s)}
          className="flex aspect-square items-center justify-center rounded-lg p-1.5 transition-colors hover:bg-muted"
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
  )
}
