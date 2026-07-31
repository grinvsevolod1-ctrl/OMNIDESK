'use client'

/**
 * Inbox visual primitives, extracted from inbox-view.tsx: per-source / lead /
 * presence colour identities, small pure formatting helpers (dates, labels,
 * avatar tints, device parsing) and the FilterChip trigger button. No InboxView
 * state — safe to import anywhere in the inbox UI.
 */

import {
  type ComponentPropsWithoutRef,
  forwardRef,
} from 'react'
import { ChevronDown } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  APP_TIME_ZONE,
  formatMskDateShort,
  formatMskDateTime,
  formatMskTime,
  mskDayKey,
  mskTodayKeys,
} from '@/lib/time'
import { getChannelMeta } from '@/lib/types'
import type { ChannelType, Conversation, LeadStatus } from '@/lib/types'
import {
  channelIcon,
  type BrandIconComponent,
} from '@/components/channel-icons'

/* -------------------------------------------------------------------------- */
/*  Visual identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Per-source visual identity. Brand-tinted accents are intentional: a manager
 * should tell Telegram vs WhatsApp vs widget apart at a glance.
 */
export const CHANNEL_VISUAL: Record<
  ChannelType,
  {
    icon: BrandIconComponent
    short: string
    badge: string
    accentText: string
    dot: string
  }
> = {
  telegram: {
    icon: channelIcon('telegram'),
    short: 'Telegram',
    badge: 'bg-sky-500/10 text-sky-600 border-sky-500/20 dark:text-sky-400',
    accentText: 'text-sky-600 dark:text-sky-400',
    dot: 'bg-sky-500',
  },
  whatsapp: {
    icon: channelIcon('whatsapp'),
    short: 'WhatsApp',
    badge:
      'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400',
    accentText: 'text-emerald-600 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
  livechat: {
    icon: channelIcon('livechat'),
    short: 'Виджет',
    badge: 'bg-muted text-muted-foreground border-border',
    accentText: 'text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
  max: {
    icon: channelIcon('max'),
    short: 'MAX',
    badge:
      'bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400',
    accentText: 'text-amber-600 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  vk: {
    icon: channelIcon('vk'),
    short: 'VK',
    badge:
      'bg-blue-500/10 text-blue-600 border-blue-500/20 dark:text-blue-400',
    accentText: 'text-blue-600 dark:text-blue-400',
    dot: 'bg-blue-500',
  },
}

/** Lead-status visual identity (badge chip + dot). */
export const LEAD_STATUS_VISUAL: Record<LeadStatus, { badge: string; dot: string }> = {
  unsubscribed: {
    badge: 'bg-sky-500/10 text-sky-600 border-sky-500/20 dark:text-sky-400',
    dot: 'bg-sky-500',
  },
  handoff: {
    badge:
      'bg-amber-500/10 text-amber-600 border-amber-500/20 dark:text-amber-400',
    dot: 'bg-amber-500',
  },
  liquid: {
    badge: 'bg-teal-500/10 text-teal-600 border-teal-500/20 dark:text-teal-400',
    dot: 'bg-teal-500',
  },
  not_liquid: {
    badge: 'bg-muted text-muted-foreground border-border',
    dot: 'bg-muted-foreground',
  },
  transferred: {
    badge:
      'bg-emerald-500/10 text-emerald-600 border-emerald-500/20 dark:text-emerald-400',
    dot: 'bg-emerald-500',
  },
}

/**
 * Live visitor presence on the website (live-chat widget only). Mirrors the
 * widget's reported state: 'open' = looking at the chat, 'minimized' = on the
 * page with the chat closed, 'away' = tab hidden, 'left' = navigated away (or
 * the heartbeat went stale). Emerald/sky/amber/muted keep within the palette.
 */
export type PresenceState = 'open' | 'minimized' | 'away' | 'left'

export const PRESENCE_VISUAL: Record<
  PresenceState,
  { label: string; dot: string; text: string; pulse: boolean }
> = {
  open: {
    label: 'В чате',
    dot: 'bg-emerald-500',
    text: 'text-emerald-600 dark:text-emerald-400',
    pulse: true,
  },
  minimized: {
    label: 'На сайте',
    dot: 'bg-sky-500',
    text: 'text-sky-600 dark:text-sky-400',
    pulse: false,
  },
  away: {
    label: 'Отошёл',
    dot: 'bg-amber-500',
    text: 'text-amber-600 dark:text-amber-400',
    pulse: false,
  },
  left: {
    label: 'Покинул сайт',
    dot: 'bg-muted-foreground',
    text: 'text-muted-foreground',
    pulse: false,
  },
}

export type SortMode = 'recent' | 'oldest' | 'unread' | 'status'

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

export function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** Stable colour index for an avatar based on the contact name. */
export function avatarTint(name: string): string {
  const palette = [
    'bg-sky-500/15 text-sky-600 dark:text-sky-400',
    'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
    'bg-amber-500/15 text-amber-600 dark:text-amber-400',
    'bg-rose-500/15 text-rose-600 dark:text-rose-400',
    'bg-teal-500/15 text-teal-600 dark:text-teal-400',
    'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400',
  ]
  let sum = 0
  for (let i = 0; i < name.length; i++) sum = (sum + name.charCodeAt(i)) % 997
  return palette[sum % palette.length]
}

/**
 * Per-account colour identity. A manager may have several Telegram / WhatsApp
 * accounts and several sites — the platform icon alone can't tell account #1
 * from account #2. We assign each connected source (keyed by its channelId) a
 * stable colour so every chip / avatar ring for that exact account looks the
 * same, and two accounts of the same platform look different. Purple/violet are
 * intentionally omitted per the design guidelines.
 */
export const SOURCE_PALETTE: { chip: string; ring: string; dot: string }[] = [
  {
    chip: 'bg-sky-500/10 text-sky-700 border-sky-500/25 dark:text-sky-300',
    ring: 'ring-sky-500/50',
    dot: 'bg-sky-500',
  },
  {
    chip: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/25 dark:text-emerald-300',
    ring: 'ring-emerald-500/50',
    dot: 'bg-emerald-500',
  },
  {
    chip: 'bg-amber-500/10 text-amber-700 border-amber-500/25 dark:text-amber-300',
    ring: 'ring-amber-500/50',
    dot: 'bg-amber-500',
  },
  {
    chip: 'bg-rose-500/10 text-rose-700 border-rose-500/25 dark:text-rose-300',
    ring: 'ring-rose-500/50',
    dot: 'bg-rose-500',
  },
  {
    chip: 'bg-teal-500/10 text-teal-700 border-teal-500/25 dark:text-teal-300',
    ring: 'ring-teal-500/50',
    dot: 'bg-teal-500',
  },
  {
    chip: 'bg-indigo-500/10 text-indigo-700 border-indigo-500/25 dark:text-indigo-300',
    ring: 'ring-indigo-500/50',
    dot: 'bg-indigo-500',
  },
  {
    chip: 'bg-orange-500/10 text-orange-700 border-orange-500/25 dark:text-orange-300',
    ring: 'ring-orange-500/50',
    dot: 'bg-orange-500',
  },
  {
    chip: 'bg-cyan-500/10 text-cyan-700 border-cyan-500/25 dark:text-cyan-300',
    ring: 'ring-cyan-500/50',
    dot: 'bg-cyan-500',
  },
]

/** Stable palette slot for a connected source, hashed from its channelId. */
export function sourceAccent(channelId: string): {
  chip: string
  ring: string
  dot: string
} {
  let sum = 0
  for (let i = 0; i < channelId.length; i++)
    sum = (sum * 31 + channelId.charCodeAt(i)) >>> 0
  return SOURCE_PALETTE[sum % SOURCE_PALETTE.length]
}

export function timeShort(iso: string): string {
  return formatMskTime(iso)
}

/** Compact relative-ish label for list rows (time today, else short date). */
export function listStamp(iso: string): string {
  const key = mskDayKey(iso)
  const { today, yesterday } = mskTodayKeys()
  if (key === today) return timeShort(iso)
  if (key === yesterday) return 'Вчера'
  return formatMskDateShort(iso)
}

export function dayLabel(iso: string): string {
  const key = mskDayKey(iso)
  const { today, yesterday } = mskTodayKeys()
  if (key === today) return 'Сегодня'
  if (key === yesterday) return 'Вчера'
  // Drop the year when it matches the current MSK year (keys are YYYY-MM-DD).
  const sameYear = key.slice(0, 4) === today.slice(0, 4)
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: sameYear ? undefined : 'numeric',
    timeZone: APP_TIME_ZONE,
  })
}

export function sourceLabel(c: Conversation): string {
    return c.channelName?.trim() || getChannelMeta(c.channelType).label
}

/**
 * Human-readable per-channel ordinal for an anonymous live-chat visitor
 * (e.g. "#7"), or null for messenger contacts / pre-migration rows. Lets a
 * manager tell several anonymous website visitors apart at a glance.
 */
export function visitorTag(c: Conversation): string | null {
  return c.channelType === 'livechat' && c.visitorNo ? `#${c.visitorNo}` : null
}

/**
 * Trigger button for a multi-select filter menu. forwardRef so Base UI's
 * `render` prop can merge its own handlers/ref/aria onto the real element.
 * Shows a count badge when one or more options are selected.
 */
export const FilterChip = forwardRef<
  HTMLButtonElement,
  { label: string; count: number; active: boolean } & ComponentPropsWithoutRef<'button'>
>(function FilterChip({ label, count, active, className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      data-active={active}
      className={cn(
        'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'bg-secondary text-secondary-foreground'
          : 'text-muted-foreground hover:bg-muted',
        className,
      )}
      {...props}
    >
      {label}
      {count > 0 ? (
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold tabular-nums text-primary-foreground">
          {count}
        </span>
      ) : null}
      <ChevronDown className="size-3 opacity-60" aria-hidden />
    </button>
  )
})

export function deviceLabel(ua: string): string {
  const browser = /Edg/.test(ua)
    ? 'Edge'
    : /OPR|Opera/.test(ua)
      ? 'Opera'
      : /Chrome/.test(ua)
        ? 'Chrome'
        : /Firefox/.test(ua)
          ? 'Firefox'
          : /Safari/.test(ua)
            ? 'Safari'
            : ''
  const os = /Windows/.test(ua)
    ? 'Windows'
    : /Android/.test(ua)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(ua)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua)
          ? 'macOS'
          : /Linux/.test(ua)
            ? 'Linux'
            : ''
  return [browser, os].filter(Boolean).join(' · ')
}

export function dateTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return formatMskDateTime(iso)
}

export function shortUrl(url?: string): string {
  if (!url) return ''
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}
