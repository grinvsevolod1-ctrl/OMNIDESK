'use client'

import {
  type ComponentPropsWithoutRef,
  Fragment,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import {
  AlertCircle,
  ArrowLeft,
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronUp,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Globe,
  History,
  Info,
  Link2,
  Loader2,
  MapPin,
  Sparkles,
  MessageCircle,
  Monitor,
  MoreVertical,
  Paperclip,
  Reply,
  Search,
  SendHorizonal,
  SlidersHorizontal,
  Smile,
  Sticker,
  Tag,
  Trash2,
  UserPlus,
  X,
  Zap,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  markConversationReadAction,
  sendMessageAction,
  sendStickerAction,
  sendVkMediaAction,
  sendWhatsappMediaAction,
} from '@/app/actions/account'
import {
  replyMessageAction,
  reactMessageAction,
  deleteMessageAction,
  forwardMessageAction,
  toggleConversationAiAction,
  acknowledgeAiHandoffAction,
  loadOlderMessagesAction,
} from '@/app/actions/messages'
import {
  dismissReplyReminderAction,
  setConversationMutedAction,
  setLeadStatusAction,
} from '@/app/actions/leads'
import {
  createMeetingAction,
  transferConversationAction,
} from '@/app/actions/conversations'
import {
  MessageContextMenu,
  type ForwardTarget,
} from '@/components/manager/message-context-menu'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { AutopilotToggle } from '@/components/manager/autopilot-toggle'
import { EditHistoryDialog } from '@/components/manager/edit-history-dialog'
import { VirtualList } from '@/components/manager/virtual-list'
import {
  channelIcon,
  TelemostIcon,
  type BrandIconComponent,
} from '@/components/channel-icons'
import { cn } from '@/lib/utils'
import {
  APP_TIME_ZONE,
  formatMskDateShort,
  formatMskDateTime,
  formatMskTime,
  mskDayKey,
  mskTodayKeys,
} from '@/lib/time'
import {
  getChannelMeta,
  LEAD_STATUS_META,
  LEAD_STATUS_OPTIONS,
  LEAD_STATUS_ORDER,
  NOT_LIQUID_REASON_META,
  NOT_LIQUID_REASON_ORDER,
  leadStatusOptionValue,
} from '@/lib/types'
import type {
  ChannelType,
  Conversation,
  ConversationMeta,
  LeadStatus,
  Message,
  NotLiquidReason,
  QuickReply,
  StickerItem,
} from '@/lib/types'

/* -------------------------------------------------------------------------- */
/*  Visual identity                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Per-source visual identity. Brand-tinted accents are intentional: a manager
 * should tell Telegram vs WhatsApp vs widget apart at a glance.
 */
const CHANNEL_VISUAL: Record<
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
const LEAD_STATUS_VISUAL: Record<LeadStatus, { badge: string; dot: string }> = {
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
type PresenceState = 'open' | 'minimized' | 'away' | 'left'

const PRESENCE_VISUAL: Record<
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

type SortMode = 'recent' | 'oldest' | 'unread' | 'status'

/* -------------------------------------------------------------------------- */
/*  Small helpers                                                             */
/* -------------------------------------------------------------------------- */

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/** Stable colour index for an avatar based on the contact name. */
function avatarTint(name: string): string {
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
const SOURCE_PALETTE: { chip: string; ring: string; dot: string }[] = [
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
function sourceAccent(channelId: string): {
  chip: string
  ring: string
  dot: string
} {
  let sum = 0
  for (let i = 0; i < channelId.length; i++)
    sum = (sum * 31 + channelId.charCodeAt(i)) >>> 0
  return SOURCE_PALETTE[sum % SOURCE_PALETTE.length]
}

function timeShort(iso: string): string {
  return formatMskTime(iso)
}

/** Compact relative-ish label for list rows (time today, else short date). */
function listStamp(iso: string): string {
  const key = mskDayKey(iso)
  const { today, yesterday } = mskTodayKeys()
  if (key === today) return timeShort(iso)
  if (key === yesterday) return 'Вчера'
  return formatMskDateShort(iso)
}

function dayLabel(iso: string): string {
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

function sourceLabel(c: Conversation): string {
    return c.channelName?.trim() || getChannelMeta(c.channelType).label
}

/**
 * Human-readable per-channel ordinal for an anonymous live-chat visitor
 * (e.g. "#7"), or null for messenger contacts / pre-migration rows. Lets a
 * manager tell several anonymous website visitors apart at a glance.
 */
function visitorTag(c: Conversation): string | null {
  return c.channelType === 'livechat' && c.visitorNo ? `#${c.visitorNo}` : null
}

/**
 * Trigger button for a multi-select filter menu. forwardRef so Base UI's
 * `render` prop can merge its own handlers/ref/aria onto the real element.
 * Shows a count badge when one or more options are selected.
 */
const FilterChip = forwardRef<
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

function deviceLabel(ua: string): string {
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

function dateTime(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return formatMskDateTime(iso)
}

function shortUrl(url?: string): string {
  if (!url) return ''
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '')
}

/* -------------------------------------------------------------------------- */
/*  Presentational atoms                                                      */
/* -------------------------------------------------------------------------- */

function StatusChip({
  status,
  detail,
  auto,
  className,
}: {
  status: LeadStatus
  detail?: NotLiquidReason
  auto?: boolean
  className?: string
}) {
  const v = LEAD_STATUS_VISUAL[status]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium leading-none',
        v.badge,
        className,
      )}
      title={auto ? 'Статус по умолчанию' : 'Статус задан вручную'}
    >
      <span className={cn('size-1.5 rounded-full', v.dot)} />
      {LEAD_STATUS_META[status].label}
      {detail ? (
        <span className="opacity-70">· {NOT_LIQUID_REASON_META[detail].label}</span>
      ) : null}
      {auto ? <span className="opacity-60">· авто</span> : null}
    </span>
  )
}

/** Tiny presence dot (list rows): a coloured dot, pulsing while "in chat". */
function PresenceDot({ state }: { state: PresenceState }) {
  const v = PRESENCE_VISUAL[state]
  return (
    <span
      className="relative flex size-2 shrink-0"
      title={`Посетитель: ${v.label.toLowerCase()}`}
      aria-label={`Посетитель ${v.label.toLowerCase()}`}
    >
      {v.pulse ? (
        <span
          className={cn(
            'absolute inline-flex size-full animate-ping rounded-full opacity-60',
            v.dot,
          )}
          aria-hidden
        />
      ) : null}
      <span className={cn('relative inline-flex size-2 rounded-full', v.dot)} aria-hidden />
    </span>
  )
}

/** Presence dot + label (open-conversation header / details). */
function PresenceBadge({
  state,
  className,
}: {
  state: PresenceState
  className?: string
}) {
  const v = PRESENCE_VISUAL[state]
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', v.text, className)}
      role="status"
      aria-live="polite"
      title="Активность посетителя на сайте в ��еальном времени"
    >
      <PresenceDot state={state} />
      {v.label}
    </span>
  )
}

/**
 * Canonical "where is this from" chip: platform icon (keeps Telegram/WhatsApp/
 * widget instantly recognisable) + the exact account/site name, tinted with the
 * source's stable per-account colour. This is the single, structured signal we
 * show in the list, the open-conversation header and the details panel so a
 * manager juggling several accounts always knows the origin at a glance.
 */
function SourceChip({
  conversation,
  size = 'sm',
  className,
}: {
  conversation: Conversation
  size?: 'sm' | 'xs'
  className?: string
}) {
  const v = CHANNEL_VISUAL[conversation.channelType]
  const Icon = v.icon
  const accent = sourceAccent(conversation.channelId)
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1 rounded-full border font-medium leading-none',
        size === 'xs' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-1 text-[11px]',
        accent.chip,
        className,
      )}
      title={`${v.short} · ${sourceLabel(conversation)}`}
    >
      <Icon className={size === 'xs' ? 'size-2.5 shrink-0' : 'size-3 shrink-0'} />
      <span className="truncate">{sourceLabel(conversation)}</span>
    </span>
  )
}

function SyncBadge({ state }: { state: 'connecting' | 'live' | 'offline' }) {
  const cfg = {
    live: {
      label: 'Онлайн',
      title: 'Синхронизация активна — новые сообщения приходят сразу',
      dot: 'bg-emerald-500',
      text: 'text-emerald-600 dark:text-emerald-400',
      pulse: true,
    },
    connecting: {
      label: 'Подключение',
      title: 'Устанавливаем соединение для синхронизации',
      dot: 'bg-amber-500',
      text: 'text-amber-600 dark:text-amber-400',
      pulse: true,
    },
    offline: {
      label: 'Переподключение',
      title:
        'Соединение прервано. Переподключаемся — пропущенные сообщения подгрузятся автоматически.',
      dot: 'bg-destructive',
      text: 'text-destructive',
      pulse: false,
    },
  }[state]
  return (
    <span
      className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', cfg.text)}
      title={cfg.title}
      role="status"
      aria-live="polite"
    >
      <span className="relative flex size-2">
        {cfg.pulse ? (
          <span
            className={cn(
              'absolute inline-flex size-full animate-ping rounded-full opacity-60',
              cfg.dot,
            )}
            aria-hidden
          />
        ) : null}
        <span className={cn('relative inline-flex size-2 rounded-full', cfg.dot)} aria-hidden />
      </span>
      {cfg.label}
    </span>
  )
}

function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim()
  if (!q) return <>{text}</>
  const idx = text.toLowerCase().indexOf(q.toLowerCase())
  if (idx === -1) return <>{text}</>
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-amber-300/50 px-0.5 text-foreground dark:bg-amber-400/30">
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </>
  )
}

/**
 * Avatar with a small platform badge in the corner. When `channelId` is given
 * we also draw a thin ring in that account's stable colour, so two accounts of
 * the same platform (e.g. two Telegram numbers) are visually distinct while the
 * corner icon still says which platform it is.
 */
function ContactAvatar({
  name,
  channel,
  channelId,
  size = 'md',
}: {
  name: string
  channel: ChannelType
  channelId?: string
  size?: 'md' | 'lg'
}) {
  const v = CHANNEL_VISUAL[channel]
  const Icon = v.icon
  const dim = size === 'lg' ? 'size-11' : 'size-10'
  const accent = channelId ? sourceAccent(channelId) : null
  return (
    <div className="relative shrink-0">
      <Avatar
        className={cn(
          dim,
          accent && `ring-2 ring-offset-2 ring-offset-card ${accent.ring}`,
        )}
      >
        <AvatarFallback className={cn('text-sm font-semibold', avatarTint(name))}>
          {initials(name)}
        </AvatarFallback>
      </Avatar>
      <span
        className="absolute -bottom-0.5 -right-0.5 flex size-4 items-center justify-center rounded-full bg-card ring-2 ring-card"
        aria-hidden
      >
        <Icon className="size-4 rounded-full" />
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Details panel (visitor / source context + status)                        */
/* -------------------------------------------------------------------------- */

function MetaRows({ meta }: { meta: ConversationMeta }) {
  const device = meta.userAgent ? deviceLabel(meta.userAgent) : ''
  const rows: { icon: typeof Globe; label: string; value: string }[] = []
  if (meta.subject) rows.push({ icon: Tag, label: 'Тема', value: meta.subject })
  if (meta.ip) rows.push({ icon: Globe, label: 'IP-адрес', value: meta.ip })
  if (meta.timezone)
    rows.push({ icon: MapPin, label: 'Часовой пояс', value: meta.timezone })
  if (device || meta.screen)
    rows.push({
      icon: Monitor,
      label: 'Устройство',
      value: [device, meta.screen].filter(Boolean).join(', '),
    })
  if (meta.language)
    rows.push({ icon: Globe, label: 'Язык', value: meta.language })
  if (meta.page)
    rows.push({ icon: Link2, label: 'Страница', value: shortUrl(meta.page) })
  if (meta.referrer)
    rows.push({
      icon: Link2,
      label: 'Источник перехода',
      value: shortUrl(meta.referrer),
    })
  rows.push({ icon: Clock, label: 'Первый визит', value: dateTime(meta.firstSeen) })

  return (
    <dl className="flex flex-col gap-3">
      {rows.map((r, i) => (
        <div key={i} className="flex items-start gap-2.5 text-xs">
          <r.icon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <dt className="text-muted-foreground">{r.label}</dt>
            <dd className="mt-0.5 break-words font-medium text-foreground">
              {r.value}
            </dd>
          </div>
        </div>
      ))}
    </dl>
  )
}

function DetailsPanel({
  conversation,
  onClose,
  onStatus,
  statusPending,
}: {
  conversation: Conversation
  onClose: () => void
  /** Receives an option value: 'auto', a status, or 'not_liquid:<reason>'. */
  onStatus: (optionValue: string) => void
  statusPending: boolean
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-4">
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Info className="size-4 text-muted-foreground" />
          О контакте
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
          aria-label="Закрыть панель"
        >
          <X className="size-4" />
        </Button>
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
        <div className="flex flex-col items-center gap-2 pb-4 text-center">
          <ContactAvatar
            name={conversation.contactName}
            channel={conversation.channelType}
            channelId={conversation.channelId}
            size="lg"
          />
          <div>
            <p className="flex items-center gap-2 text-sm font-semibold">
              {conversation.contactName}
              {visitorTag(conversation) ? (
                <span className="shrink-0 rounded bg-muted px-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                  {visitorTag(conversation)}
                </span>
              ) : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1.5">
            <SourceChip conversation={conversation} />
          </div>
        </div>

        {/* Status control */}
        <div className="mb-4 rounded-lg border border-border bg-muted/30 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
              <Tag className="size-3.5" />
              Статус лида
            </span>
            {statusPending ? (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            ) : (
              <StatusChip
                status={conversation.status}
                detail={conversation.statusDetail}
                auto={!conversation.statusManual}
              />
            )}
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              onClick={() => onStatus('auto')}
              disabled={statusPending}
              className={cn(
                'rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                !conversation.statusManual
                  ? 'border-foreground/20 bg-card text-foreground shadow-sm'
                  : 'border-transparent text-muted-foreground hover:bg-card/60',
              )}
            >
              Авто
            </button>
            {LEAD_STATUS_OPTIONS.map((opt) => {
              const current = conversation.statusManual
                ? leadStatusOptionValue(
                    conversation.status,
                    conversation.statusDetail,
                  )
                : null
              const activeStatus = current === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => onStatus(opt.value)}
                  disabled={statusPending}
                  className={cn(
                    'flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors',
                    activeStatus
                      ? 'border-foreground/20 bg-card text-foreground shadow-sm'
                      : 'border-transparent text-muted-foreground hover:bg-card/60',
                  )}
                >
                  <span
                    className={cn(
                      'size-1.5 rounded-full',
                      LEAD_STATUS_VISUAL[opt.status].dot,
                    )}
                  />
                  {opt.label}
                </button>
              )
            })}
          </div>
        </div>

        {conversation.meta ? (
          <div>
            <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Данные о переходе
            </p>
            <MetaRows meta={conversation.meta} />
          </div>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            Нет дополнительных данных об источнике для этого канала.
          </p>
        )}
      </div>
    </div>
  )
}

/* -------------------------------------------------------------------------- */
/*  Lead-status menu helpers (shared by context menu + header dropdown)       */
/* -------------------------------------------------------------------------- */

function StatusRadioItems({ Item }: { Item: typeof ContextMenuRadioItem }) {
  return (
    <>
      <Item value="auto">
        <span className="flex items-center gap-2">
          <CheckCheck className="size-3.5 text-muted-foreground" />
          Авто
        </span>
      </Item>
      {LEAD_STATUS_OPTIONS.map((opt) => (
        <Item key={opt.value} value={opt.value}>
          <span className="flex items-center gap-2">
            <span
              className={cn(
                'size-2 rounded-full',
                LEAD_STATUS_VISUAL[opt.status].dot,
              )}
            />
            {opt.label}
          </span>
        </Item>
      ))}
    </>
  )
}

/* -------------------------------------------------------------------------- */
/*  Media rendering + emoji / sticker pickers                                  */
/* -------------------------------------------------------------------------- */

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
function isMediaPlaceholder(body: string): boolean {
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
  const isVideo =
    message.mediaType === 'video' || message.mediaType === 'video_note'

  // Close on Escape for keyboard users.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!url) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Просмотр вложения"
      className="fixed inset-0 z-[100] flex flex-col bg-black/90"
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
        className="flex min-h-0 flex-1 items-center justify-center p-4"
        onClick={(e) => e.stopPropagation()}
      >
        {isVideo ? (
          <video
            src={url}
            controls
            autoPlay
            className="max-h-full max-w-full rounded-lg"
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
    </div>
  )
}

/**
 * Render a message's media. Streams bytes from `/api/media/{id}` via the panel
 * proxy. On error (e.g. expired WhatsApp media) falls back to a small notice.
 * Images and videos are clickable to open a fullscreen viewer where they can be
 * saved.
 */
function MessageMedia({ message }: { message: Message }) {
  const [failed, setFailed] = useState(false)
  const [lightbox, setLightbox] = useState(false)
  const url = message.mediaUrl
  const type = message.mediaType

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

/** Curated emoji set grouped by category. Plain text — no extra dependency. */
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
      '💕', '💞', '💓', '💗', '💖', '💘', '💝', '✨', '🔥', '⭐',
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
function EmojiPicker({ onPick }: { onPick: (emoji: string) => void }) {
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
function StickerPicker({
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

/* -------------------------------------------------------------------------- */
/*  Main component                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Shape of a parsed `/api/stream` SSE payload we care about on the client.
 * Mirrors the server's RealtimeEvent but kept local so this client component
 * never imports the server-only realtime module (which pulls in `pg`).
 */
interface RealtimeStreamEvent {
  type?: 'message' | 'conversation' | 'channel' | 'typing'
  event?: 'insert' | 'update'
  conversationId?: string
  id?: string
  reactions?: Array<{ emoji: string; fromMe: boolean }> | null
  deletedAt?: string | null
  deletedOrigin?: 'self' | 'remote' | null
  status?: string
  /** Failure reason for a message 'update' whose status is 'failed'. */
  errorReason?: string | null
  // Typing pings (visitor → manager).
  actor?: 'visitor' | 'agent'
  typing?: boolean
  draft?: string
  // Presence pings (visitor → manager).
  presence?: PresenceState
  contactName?: string
}

/** Live "visitor is typing" state for a conversation. */
interface VisitorTyping {
  draft: string
  name: string
  /** Epoch ms when this ping arrived; used to auto-expire a stale indicator. */
  at: number
}

/** Auto-clear a typing indicator if no fresh ping arrives within this window. */
const TYPING_TTL_MS = 6_000

/** Live "visitor presence" state for a conversation. */
interface VisitorPresence {
  state: PresenceState
  /** Epoch ms of the last ping; a stale entry is downgraded to 'left'. */
  at: number
}

/**
 * If no presence ping (incl. the widget's 25s heartbeat) arrives within this
 * window, the visitor is treated as gone — covers crashes / network loss where
 * the 'left' beacon never fired.
 */
const PRESENCE_TTL_MS = 60_000

/**
 * Messenger-style delivery ticks for an outbound message:
 *   sent → single check, delivered → double check, read → blue double check,
 *   failed → warning. Legacy rows (no status) fall back to a single check.
 */
function DeliveryTicks({ status }: { status?: Message['status'] }) {
  if (status === 'failed') {
    return (
      <AlertCircle className="size-3 text-destructive" aria-label="Не доставлено" />
    )
  }
  if (status === 'read') {
    return <CheckCheck className="size-3 text-sky-400" aria-label="Прочитано" />
  }
  if (status === 'delivered') {
    return <CheckCheck className="size-3" aria-label="Доставлено" />
  }
  return <Check className="size-3" aria-label="Отправлено" />
}

/* -------------------------------------------------------------------------- */
/*  Message composer (isolated for performance)                               */
/* -------------------------------------------------------------------------- */

interface MessageComposerProps {
  conversationId: string
  channelType: ChannelType
  channelId: string
  /** Reads the saved draft for a conversation (called once, in the lazy state
   *  initialiser — a getter avoids reading the parent's ref during render). */
  getInitialDraft: (conversationId: string) => string
  /** Persist the unsent draft back to the parent (called on blur/unmount only,
   *  never per keystroke — that is the whole point of this isolation). */
  onPersistDraft: (text: string) => void
  onSend: (text: string) => void
  onSendSticker: (sticker: StickerItem) => void
  onSendMediaFile: (file: File, caption: string) => void
  aiLed: boolean
  /** Fired when the manager tries to type/send while the AI leads the thread. */
  onBlockedInteract: () => void
  onToggleAi: () => void
  statusPending: boolean
  pending: boolean
  quickReplies: QuickReply[]
  telemostEnabled: boolean
  onStartMeeting: () => void
  meetingPending: boolean
  replyActive: boolean
}

/**
 * The reply composer, extracted into its own memoised component so that typing
 * only re-renders this small subtree — not the entire InboxView (conversation
 * list + message thread + details panel), which previously caused visible lag
 * on every keystroke because the draft lived in the parent's state.
 *
 * The text lives in LOCAL state here. Per-conversation draft persistence (so an
 * unsent message survives switching threads, Telegram-style) is handled by the
 * parent keying this component on `conversationId`: React remounts it per
 * thread, we seed from `initialDraft` on mount and write back via
 * `onPersistDraft` on unmount — none of which touches the parent on keystroke.
 */
const MessageComposer = memo(function MessageComposer({
  conversationId,
  channelType,
  channelId,
  getInitialDraft,
  onPersistDraft,
  onSend,
  onSendSticker,
  onSendMediaFile,
  aiLed,
  onBlockedInteract,
  onToggleAi,
  statusPending,
  pending,
  quickReplies,
  telemostEnabled,
  onStartMeeting,
  meetingPending,
  replyActive,
}: MessageComposerProps) {
  const [text, setText] = useState(() => getInitialDraft(conversationId))
  const [quickRepliesOpen, setQuickRepliesOpen] = useState(false)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  // Mirror the latest text + persist callback in refs so the unmount cleanup can
  // save the current value without listing `text` in its deps. The refs are
  // updated in effects (never during render) to satisfy the refs lint rule.
  const textRef = useRef(text)
  useEffect(() => {
    textRef.current = text
  }, [text])
  const persistRef = useRef(onPersistDraft)
  useEffect(() => {
    persistRef.current = onPersistDraft
  }, [onPersistDraft])
  useEffect(() => {
    // On unmount (i.e. switching to another conversation) save the unsent draft.
    return () => persistRef.current(textRef.current)
  }, [])

  const resizeComposer = useCallback(() => {
    const el = composerRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [])

  const submit = useCallback(() => {
    if (aiLed) {
      onBlockedInteract()
      return
    }
    const body = text.trim()
    if (!body) return
    onSend(body)
    setText('')
    requestAnimationFrame(resizeComposer)
  }, [aiLed, text, onSend, onBlockedInteract, resizeComposer])

  function insertQuickReply(value: string) {
    setText((prev) => {
      const base = prev.trimEnd()
      return base ? `${base} ${value}` : value
    })
    requestAnimationFrame(() => {
      const el = composerRef.current
      if (!el) return
      el.focus()
      const end = el.value.length
      el.setSelectionRange(end, end)
      resizeComposer()
    })
  }

  return (
    <div className={cn('bg-card', replyActive ? '' : 'border-t border-border')}>
      {/* Quick replies tray — manager's saved canned answers, one tap to
          insert into the draft. Collapsed by default to keep the composer
          uncluttered. */}
      {quickReplies.length > 0 ? (
        <div className="border-b border-border/60 px-3 pt-2">
          <button
            type="button"
            onClick={() => setQuickRepliesOpen((v) => !v)}
            className="flex items-center gap-1.5 rounded-md text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
            aria-expanded={quickRepliesOpen}
          >
            <Zap className="size-3.5" />
            Автоответы
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">
              {quickReplies.length}
            </span>
            <ChevronDown
              className={cn(
                'size-3.5 transition-transform',
                quickRepliesOpen && 'rotate-180',
              )}
            />
          </button>
          {quickRepliesOpen ? (
            <div className="scrollbar-thin -mx-1 mt-2 flex max-h-28 flex-wrap gap-1.5 overflow-y-auto px-1 pb-2">
              {quickReplies.map((qr) => (
                <button
                  key={qr.id}
                  type="button"
                  onClick={() => insertQuickReply(qr.body)}
                  title={qr.body}
                  className="max-w-[15rem] truncate rounded-full border border-border bg-muted/60 px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
                >
                  {qr.title?.trim() || qr.body}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {aiLed ? (
        <button
          type="button"
          onClick={onToggleAi}
          disabled={statusPending}
          className="flex w-full items-center gap-2 border-b border-primary/20 bg-primary/10 px-4 py-2 text-left text-xs font-medium text-primary transition-colors hover:bg-primary/15"
        >
          <Sparkles className="size-3.5 shrink-0" />
          <span className="flex-1">
            ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.
          </span>
          <span className="shrink-0 rounded-full bg-primary px-2 py-0.5 text-[10px] text-primary-foreground">
            Отключить ИИ
          </span>
        </button>
      ) : null}

      <form
        className="flex items-end gap-1.5 p-3"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <EmojiPicker
          onPick={(emoji) => {
            setText((d) => d + emoji)
            requestAnimationFrame(resizeComposer)
          }}
        />
        {channelType === 'telegram' ? (
          <StickerPicker channelId={channelId} onSend={onSendSticker} />
        ) : null}
        {channelType === 'whatsapp' || channelType === 'vk' ? (
          <>
            <input
              ref={fileInputRef}
              type="file"
              className="hidden"
              accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip"
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) {
                  onSendMediaFile(f, text.trim())
                  setText('')
                }
                e.target.value = ''
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
              disabled={pending}
              onClick={() => fileInputRef.current?.click()}
              aria-label="Прикрепить файл"
              title="Прикрепить файл (фото, видео, документ)"
            >
              <Paperclip className="size-4" />
            </Button>
          </>
        ) : null}
        {telemostEnabled ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 rounded-full text-muted-foreground hover:text-foreground"
            disabled={pending || meetingPending}
            onClick={onStartMeeting}
            aria-label="Создать видеовстречу"
            title="Создать видеовстречу в Яндекс Телемост и отправить ссылку клиенту"
          >
            {meetingPending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <TelemostIcon className="size-4" />
            )}
          </Button>
        ) : null}
        <textarea
          ref={composerRef}
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value)
            resizeComposer()
          }}
          onKeyDown={(e) => {
            // Don't submit mid-IME-composition (CJK): Enter confirms the
            // candidate, and Safari reports keyCode 229 for that.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return
            // Enter sends, Shift+Enter inserts a newline (messenger UX).
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
          onMouseDown={(e) => {
            // While the AI leads the thread the composer is locked — vibrate the
            // AI button to point the manager at the fix.
            if (aiLed) {
              e.preventDefault()
              onBlockedInteract()
            }
          }}
          readOnly={aiLed}
          placeholder={
            aiLed
              ? 'ИИ отвечает за вас. Отключите ИИ, чтобы писать.'
              : 'Написать сообщение…'
          }
          aria-label="Текст ответа"
          className={cn(
            'scrollbar-thin max-h-40 min-h-[40px] flex-1 resize-none rounded-2xl bg-muted px-4 py-2.5 text-sm leading-relaxed outline-none transition-colors placeholder:text-muted-foreground focus-visible:bg-card focus-visible:ring-[3px] focus-visible:ring-ring/30',
            aiLed && 'cursor-not-allowed opacity-60',
          )}
        />
        <Button
          type="submit"
          size="icon"
          className="size-10 shrink-0 rounded-full"
          disabled={pending || !text.trim() || aiLed}
          aria-label="Отправить"
        >
          <SendHorizonal className="size-4" />
        </Button>
      </form>
    </div>
  )
})

export function InboxView({
  conversations: rawConversations,
  messagesByConversation,
  currentUser,
  quickReplies = [],
  autopilot,
  aiMasterEnabled = false,
  ownedChannelIds = [],
  transferTargets = [],
  telemostEnabled = false,
}: {
  conversations: Conversation[]
  messagesByConversation: Record<string, Message[]>
  currentUser: string
  quickReplies?: QuickReply[]
  autopilot?: { enabled: boolean; enabledCount: number }
  /**
   * Global AI master switch (set on /admin/ai). When on, the AI leads every
   * conversation by default; a manager pauses individual threads to reply by
   * hand. Drives the blocked composer + "AI is leading" affordance.
   */
  aiMasterEnabled?: boolean
  /**
   * Channel ids this manager actually owns. Leads routed in from a shared/pool
   * account (e.g. while another manager was on lunch) keep a foreign channel —
   * we must NOT expose that account's name. Such leads appear as ordinary leads
   * with a generic channel-type label instead.
   */
  ownedChannelIds?: string[]
  /** Colleagues this manager can hand a conversation off to. */
  transferTargets?: { id: string; name: string; onLunch: boolean }[]
  /** Whether the Yandex Telemost video-meeting button is available. */
  telemostEnabled?: boolean
}) {
  const router = useRouter()
  // Hide foreign account names: blank the channel name for any lead whose
  // channel this manager doesn't own, so the other account stays invisible.
  const conversations = useMemo(() => {
    if (ownedChannelIds.length === 0) return rawConversations
    const owned = new Set(ownedChannelIds)
    return rawConversations.map((c) =>
      owned.has(c.channelId) ? c : { ...c, channelName: undefined },
    )
  }, [rawConversations, ownedChannelIds])
  const [activeId, setActiveId] = useState<string | null>(null)
  // Per-conversation composer drafts. Like Telegram, an unsent message is kept
  // when you switch to another conversation and restored when you come back.
  // Kept in a ref (not state) so the MessageComposer — which is keyed by
  // conversation id and owns the live text in local state — can seed from and
  // write back to it WITHOUT ever re-rendering this large parent on a keystroke.
  const draftsRef = useRef<Record<string, string>>({})
  const persistDraft = useCallback((id: string, text: string) => {
    if (text) draftsRef.current[id] = text
    else delete draftsRef.current[id]
  }, [])
  const getDraft = useCallback((id: string) => draftsRef.current[id] ?? '', [])
  const [replyTarget, setReplyTarget] = useState<Message | null>(null)
  // Message whose edit history is open in the dialog (null = closed).
  const [historyMessage, setHistoryMessage] = useState<Message | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  // Conversation hand-off dialog state. `transferForId` holds the conversation
  // being handed off (null = dialog closed); the picker/note drive the submit.
  const [transferForId, setTransferForId] = useState<string | null>(null)
  const [transferTo, setTransferTo] = useState('')
  const [transferNote, setTransferNote] = useState('')
  const [transferPending, setTransferPending] = useState(false)
  // Telemost video-meeting creation in progress (disables the composer button).
  const [meetingPending, setMeetingPending] = useState(false)

  const [search, setSearch] = useState('')
  // Multi-select filters. An empty Set means "no filter" (show everything),
  // which keeps the common case cheap and avoids a magic 'all' sentinel.
  const [typeFilter, setTypeFilter] = useState<Set<ChannelType>>(
    () => new Set(),
  )
  const [sourceFilter, setSourceFilter] = useState<Set<string>>(() => new Set())
  const [statusFilter, setStatusFilter] = useState<Set<LeadStatus>>(
    () => new Set(),
  )
  // «Не ликвид» reason refinement (Гео / -18 / NA / TRASH). When non-empty it
  // narrows the list to not-liquid leads matching the chosen reasons.
  const [reasonFilter, setReasonFilter] = useState<Set<NotLiquidReason>>(
    () => new Set(),
  )
  const [sortMode, setSortMode] = useState<SortMode>('recent')

  // Toggle a value in/out of a Set-based filter (immutably, for React).
  const toggleType = useCallback((value: ChannelType) => {
    setTypeFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])
  const toggleSource = useCallback((value: string) => {
    setSourceFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])
  const toggleStatus = useCallback((value: LeadStatus) => {
    setStatusFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])
  const toggleReason = useCallback((value: NotLiquidReason) => {
    setReasonFilter((prev) => {
      const next = new Set(prev)
      if (next.has(value)) {
        next.delete(value)
      } else {
        next.add(value)
      }
      return next
    })
  }, [])

  // Per-conversation message cache, patched live by the SSE handler. Declared
  // here (above the list memo) so sorting can detect threads whose last message
  // is inbound, i.e. still awaiting a manager reply.
  const [localMessages, setLocalMessages] = useState<
    Record<string, Message[]>
  >(messagesByConversation)

  // "Load older messages" state. Threads hydrate with only the most-recent
  // slice (see MESSAGE_HISTORY_LIMIT server-side); this lets a manager pull
  // older history on demand. `noOlder` marks threads with nothing left to load;
  // the scroll container ref preserves the reading position across a prepend.
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [noOlder, setNoOlder] = useState<Record<string, boolean>>({})
  const messagesScrollRef = useRef<HTMLDivElement | null>(null)

  const handleLoadOlder = useCallback(async () => {
    if (!activeId || loadingOlder) return
    const current = localMessages[activeId] ?? []
    const oldest = current[0]
    if (!oldest) return
    setLoadingOlder(true)
    const container = messagesScrollRef.current
    const prevHeight = container?.scrollHeight ?? 0
    try {
      const before = new Date(oldest.createdAt).toISOString()
      const res = await loadOlderMessagesAction(activeId, before)
      if (res.ok && res.messages.length > 0) {
        setLocalMessages((prev) => {
          const existing = prev[activeId] ?? []
          const known = new Set(existing.map((m) => m.id))
          const older = res.messages.filter((m) => !known.has(m.id))
          if (older.length === 0) return prev
          return { ...prev, [activeId]: [...older, ...existing] }
        })
        // Keep the viewport anchored to the same message after older ones are
        // prepended above it (otherwise the list would jump to the top).
        requestAnimationFrame(() => {
          const c = messagesScrollRef.current
          if (c) c.scrollTop = c.scrollHeight - prevHeight
        })
      }
      if (!res.hasMore) setNoOlder((p) => ({ ...p, [activeId]: true }))
    } catch {
      toast.error('Не удалось загрузить историю')
    } finally {
      setLoadingOlder(false)
    }
  }, [activeId, loadingOlder, localMessages])

  // Optimistic "no reply needed" dismissals (conversationId -> dismissal time in
  // ms). Lets the badge/sorting update instantly before the server round-trip,
  // and is merged with the persisted `replyDismissedAt` from the server.
  const [dismissedOverrides, setDismissedOverrides] = useState<
    Record<string, number>
  >({})

  // Optimistic mute overrides (conversationId -> muted) so muting/unmuting
  // reflects instantly. Merged with the persisted `muted` flag from the server.
  const [mutedOverrides, setMutedOverrides] = useState<Record<string, boolean>>(
    {},
  )
  // Optimistic per-conversation AI-lead state, keyed by conversation id.
  const [aiOverrides, setAiOverrides] = useState<Record<string, boolean>>({})
  // Handoffs already acknowledged this session (guards the ack effect against
  // duplicate server calls). Not state: acknowledgement clears visually via the
  // "exclude the active thread" rule, and the server flag drives everything else.
  const ackedHandoffsRef = useRef<Record<string, boolean>>({})
  // Set true briefly to shake the AI button — the hint shown when a manager
  // tries to send while the AI is leading the thread.
  const [aiButtonPulse, setAiButtonPulse] = useState(false)
  const aiPulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pulseAiButton = useCallback(() => {
    if (aiPulseTimer.current) clearTimeout(aiPulseTimer.current)
    setAiButtonPulse(true)
    aiPulseTimer.current = setTimeout(() => setAiButtonPulse(false), 600)
  }, [])
  // Whether to reveal muted/silenced threads in the list (hidden by default).
  const [showMuted, setShowMuted] = useState(false)

  const [syncState, setSyncState] = useState<'connecting' | 'live' | 'offline'>(
    'connecting',
  )

  // Live "visitor is typing" state, keyed by conversation id. Patched by the
  // SSE 'typing' handler and swept for staleness on an interval.
  const [typingByConv, setTypingByConv] = useState<
    Record<string, VisitorTyping>
  >({})

  // Live "visitor presence" state, keyed by conversation id. Patched by the SSE
  // 'presence' handler; stale entries are downgraded to 'left' by the sweep.
  const [presenceByConv, setPresenceByConv] = useState<
    Record<string, VisitorPresence>
  >({})

  const messagesEndRef = useRef<HTMLDivElement | null>(null)

  // Latest values for the reminder interval to read without re-subscribing, plus
  // a per-conversation throttle so we never spam the same unanswered thread.
  const reminderRef = useRef<{
    conversations: Conversation[]
    awaiting: Map<string, { waiting: boolean; since: number }>
    activeId: string | null
    lastReminded: Map<string, number>
  }>({
    conversations: [],
    awaiting: new Map(),
    activeId: null,
    lastReminded: new Map(),
  })

  // Realtime: refresh on worker updates and track connection state.
  useEffect(() => {
    // Coalesce bursts of realtime events into a single server refetch.
    // router.refresh() re-runs the entire server component tree (re-querying
    // all conversations + messages), so calling it once per event caused a
    // refresh storm whenever several conversations were active at once.
    let refreshTimer: ReturnType<typeof setTimeout> | null = null
    const scheduleRefresh = () => {
      if (refreshTimer) return
      refreshTimer = setTimeout(() => {
        refreshTimer = null
        router.refresh()
      }, 400)
    }
    const es = new EventSource('/api/stream')
    es.addEventListener('ready', () => setSyncState('live'))
    es.onopen = () => setSyncState('live')
    es.addEventListener('update', (e) => {
      setSyncState('live')
      let data: RealtimeStreamEvent | null = null
      try {
        data = JSON.parse((e as MessageEvent).data) as RealtimeStreamEvent
      } catch {
        data = null
      }
      // Message changed in place (reaction toggled / soft-deleted): patch just
      // that message locally so the change appears instantly without a full
      // server refetch (and without clobbering other optimistic state).
      if (
        data &&
        data.type === 'message' &&
        data.event === 'update' &&
        data.conversationId &&
        data.id
      ) {
        const convId = data.conversationId
        const msgId = data.id
        const deletedAt = data.deletedAt ?? null
        const isDeleted = Boolean(deletedAt)
        const deletedOrigin =
          data.deletedOrigin === 'self' || data.deletedOrigin === 'remote'
            ? data.deletedOrigin
            : undefined
        const reactions = Array.isArray(data.reactions)
          ? data.reactions.filter((r) => r && typeof r.emoji === 'string')
          : []
        const nextStatus = data.status as Message['status'] | undefined
        const nextErrorReason =
          typeof data.errorReason === 'string' ? data.errorReason : undefined
        setLocalMessages((prev) => {
          const list = prev[convId]
          if (!list) return prev
          return {
            ...prev,
            [convId]: list.map((m) =>
              m.id === msgId
                ? isDeleted
                  ? {
                      // Preserve the original content (body + media); just stamp
                      // the deleted marker so nothing is lost in the thread.
                      ...m,
                      deletedAt: deletedAt ?? new Date().toISOString(),
                      deletedOrigin: deletedOrigin ?? m.deletedOrigin,
                    }
                  : {
                      ...m,
                      reactions: reactions.length ? reactions : undefined,
                      ...(nextStatus ? { status: nextStatus } : {}),
                      ...(nextStatus === 'failed'
                        ? { errorReason: nextErrorReason }
                        : {}),
                    }
                : m,
            ),
          }
        })
        return
      }
      // Everything else (new inbound message, conversation/channel changes):
      // pull fresh server data (debounced to avoid a refresh storm).
      scheduleRefresh()
    })
    // Ephemeral "visitor is typing" pings (with a live draft preview). Kept in
    // local state only — never persisted, never trigger a refetch.
    es.addEventListener('typing', (e) => {
      let data: RealtimeStreamEvent | null = null
      try {
        data = JSON.parse((e as MessageEvent).data) as RealtimeStreamEvent
      } catch {
        data = null
      }
      if (!data || data.actor !== 'visitor' || !data.conversationId) return
      const convId = data.conversationId
      if (data.typing === false) {
        setTypingByConv((prev) => {
          if (!prev[convId]) return prev
          const next = { ...prev }
          delete next[convId]
          return next
        })
        return
      }
      setTypingByConv((prev) => ({
        ...prev,
        [convId]: {
          draft: data.draft ?? '',
          name: data.contactName ?? 'Посетитель',
          at: Date.now(),
        },
      }))
    })
    // Ephemeral visitor presence (on the site / in chat / away / left). Local
    // state only — never persisted, never triggers a refetch.
    es.addEventListener('presence', (e) => {
      let data: RealtimeStreamEvent | null = null
      try {
        data = JSON.parse((e as MessageEvent).data) as RealtimeStreamEvent
      } catch {
        data = null
      }
      if (!data || data.actor !== 'visitor' || !data.conversationId) return
      if (!data.presence) return
      const convId = data.conversationId
      const state = data.presence
      setPresenceByConv((prev) => ({
        ...prev,
        [convId]: { state, at: Date.now() },
      }))
    })
    es.onerror = () => setSyncState('offline')
    // Sweep stale typing indicators (in case a "stopped" ping is ever lost).
    const sweep = setInterval(() => {
      setTypingByConv((prev) => {
        const now = Date.now()
        let changed = false
        const next: Record<string, VisitorTyping> = {}
        for (const [id, t] of Object.entries(prev)) {
          if (now - t.at < TYPING_TTL_MS) next[id] = t
          else changed = true
        }
        return changed ? next : prev
      })
      // Downgrade stale presence to 'left' (kept in place so the manager still
      // sees the last-known status rather than it vanishing).
      setPresenceByConv((prev) => {
        const now = Date.now()
        let changed = false
        const next: Record<string, VisitorPresence> = {}
        for (const [id, p] of Object.entries(prev)) {
          if (p.state !== 'left' && now - p.at > PRESENCE_TTL_MS) {
            next[id] = { state: 'left', at: p.at }
            changed = true
          } else {
            next[id] = p
          }
        }
        return changed ? next : prev
      })
    }, 1_000)
    return () => {
      es.close()
      clearInterval(sweep)
      if (refreshTimer) clearTimeout(refreshTimer)
    }
  }, [router])

  const typeCounts = useMemo(() => {
    const counts: Record<ChannelType, number> = {
      telegram: 0,
      whatsapp: 0,
      livechat: 0,
      max: 0,
      vk: 0,
    }
    for (const c of conversations) counts[c.channelType] += 1
    return counts
  }, [conversations])

  const statusCounts = useMemo(() => {
    const counts: Record<LeadStatus, number> = {
      unsubscribed: 0,
      handoff: 0,
      liquid: 0,
      not_liquid: 0,
      transferred: 0,
    }
    for (const c of conversations) counts[c.status] += 1
    return counts
  }, [conversations])

  const reasonCounts = useMemo(() => {
    const counts: Record<NotLiquidReason, number> = {
      geo: 0,
      under18: 0,
      na: 0,
      trash: 0,
    }
    for (const c of conversations) {
      if (c.status === 'not_liquid' && c.statusDetail)
        counts[c.statusDetail] += 1
    }
    return counts
  }, [conversations])

  const sources = useMemo(() => {
    const owned = ownedChannelIds.length > 0 ? new Set(ownedChannelIds) : null
    const map = new Map<
      string,
      { id: string; label: string; type: ChannelType; count: number }
    >()
    for (const c of conversations) {
      if (typeFilter.size > 0 && !typeFilter.has(c.channelType)) continue
      // Only the manager's own accounts are sortable sources; leads routed in
      // from a foreign/pool account stay as ordinary leads (no source entry).
      if (owned && !owned.has(c.channelId)) continue
      const existing = map.get(c.channelId)
      if (existing) existing.count += 1
      else
        map.set(c.channelId, {
          id: c.channelId,
          label: sourceLabel(c),
          type: c.channelType,
          count: 1,
        })
    }
    return Array.from(map.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    )
  }, [conversations, typeFilter, ownedChannelIds])

  // Effective mute state: optimistic override wins, else the persisted flag.
  const isMuted = useCallback(
    (c: Conversation) => mutedOverrides[c.id] ?? Boolean(c.muted),
    [mutedOverrides],
  )

  // For each conversation, work out whether it is still awaiting a manager reply
  // (the last message is inbound) and since when. Live-chat threads that have
  // been resolved are excluded. Falls back to the unread counter when a thread's
  // messages aren't cached yet. Drives both the "unread/unanswered on top"
  // sorting and the periodic "you haven't replied" reminder.
  const awaitingReply = useMemo(() => {
    const map = new Map<string, { waiting: boolean; since: number }>()
    for (const c of conversations) {
      const msgs = localMessages[c.id]
      let waiting: boolean
      let since: number
      if (msgs && msgs.length > 0) {
        const last = msgs[msgs.length - 1]
        waiting = last.direction === 'in'
        since = new Date(last.createdAt).getTime()
      } else {
        waiting = c.unread > 0
        since = new Date(c.lastMessageAt).getTime()
      }
      // A manual "no reply needed" dismissal silences the thread until a newer
      // inbound message arrives (since > dismissedAt reactivates it). We take the
      // max of the optimistic override and the persisted server timestamp.
      if (waiting) {
        const dismissedAt = Math.max(
          dismissedOverrides[c.id] ?? 0,
          c.replyDismissedAt ? new Date(c.replyDismissedAt).getTime() : 0,
        )
        if (dismissedAt >= since) waiting = false
      }
      // Muted contacts never count as awaiting a reply (no badge, no reminder).
      if (mutedOverrides[c.id] ?? Boolean(c.muted)) waiting = false
      map.set(c.id, { waiting, since })
    }
    return map
  }, [conversations, localMessages, dismissedOverrides, mutedOverrides])

  // How many muted threads exist (drives the "show silenced" toggle).
  const mutedCount = useMemo(
    () => conversations.filter((c) => isMuted(c)).length,
    [conversations, isMuted],
  )

  // Keep the reminder interval's snapshot fresh. Writing to the ref in an effect
  // (instead of during render) keeps this a proper post-render side-effect.
  useEffect(() => {
    reminderRef.current.conversations = conversations
    reminderRef.current.awaiting = awaitingReply
    reminderRef.current.activeId = activeId
  }, [conversations, awaitingReply, activeId])

  // Periodic nudge: if a contact's last message has gone unanswered for a while
  // and the manager isn't currently looking at that thread, pop a reminder toast.
  // Throttled per conversation so it nudges instead of nagging non-stop.
  useEffect(() => {
    const REMIND_AFTER_MS = 90_000 // grace period before the first nudge
    const REMIND_COOLDOWN_MS = 180_000 // re-nudge the same thread at most this often
    const TICK_MS = 30_000

    const tick = () => {
      if (typeof document !== 'undefined' && document.hidden) return
      const { conversations, awaiting, activeId, lastReminded } =
        reminderRef.current
      const now = Date.now()
      let pick: { id: string; name: string; since: number } | null = null
      for (const c of conversations) {
        if (c.id === activeId) continue // already on screen — no need to nag
        const a = awaiting.get(c.id)
        if (!a || !a.waiting) continue
        if (now - a.since < REMIND_AFTER_MS) continue
        if (now - (lastReminded.get(c.id) ?? 0) < REMIND_COOLDOWN_MS) continue
        // Surface the longest-waiting thread first.
        if (!pick || a.since < pick.since) {
          pick = { id: c.id, name: c.contactName, since: a.since }
        }
      }
      if (!pick) return
      reminderRef.current.lastReminded.set(pick.id, now)
      const waitedMin = Math.max(1, Math.round((now - pick.since) / 60_000))
      const picked = pick
      toast.warning(`Чувак, ты не ответил: ${picked.name}`, {
        description: `Сообщение ждёт ответа уже ${waitedMin} мин. Может, поднимешь жопу?`,
        duration: 10_000,
        action: {
          label: 'Открыть',
          onClick: () => setActiveId(picked.id),
        },
      })
    }

    const timer = setInterval(tick, TICK_MS)
    return () => clearInterval(timer)
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = conversations.filter((c) => {
      // Muted contacts are hidden by default; reveal them via the toggle. The
      // currently-open thread always stays visible so it never vanishes mid-chat.
      if (isMuted(c) && !showMuted && c.id !== activeId) return false
  if (typeFilter.size > 0 && !typeFilter.has(c.channelType)) return false
  if (sourceFilter.size > 0 && !sourceFilter.has(c.channelId)) return false
  if (statusFilter.size > 0 && !statusFilter.has(c.status)) return false
  if (
    reasonFilter.size > 0 &&
    (c.status !== 'not_liquid' ||
      !c.statusDetail ||
      !reasonFilter.has(c.statusDetail))
  )
    return false
  if (!q) return true
      // Match on contact/source metadata first (cheap), then fall back to a
      // full-text scan of every message we've loaded for this thread so search
      // covers the whole conversation history, not just the last message.
      if (
        c.contactName.toLowerCase().includes(q) ||
        c.lastMessage.toLowerCase().includes(q) ||
        sourceLabel(c).toLowerCase().includes(q)
      ) {
        return true
      }
      const msgs = localMessages[c.id]
      return msgs
        ? msgs.some((m) => m.body?.toLowerCase().includes(q))
        : false
    })
    const byRecent = (a: Conversation, b: Conversation) => {
      const timeDelta =
        new Date(b.lastMessageAt).getTime() - new Date(a.lastMessageAt).getTime()
      if (timeDelta !== 0) return timeDelta
      return a.id.localeCompare(b.id)
    }
    const statusRank = (c: Conversation) => LEAD_STATUS_ORDER.indexOf(c.status)
    // A thread "needs attention" when it has unread messages OR its last message
    // is inbound (read but not yet answered). These always float to the very top,
    // regardless of the chosen sort mode, so managers can't miss them.
    const needsAttention = (c: Conversation) =>
      c.unread > 0 || (awaitingReply.get(c.id)?.waiting ?? false)
    return [...list].sort((a, b) => {
      const attnDelta =
        (needsAttention(b) ? 1 : 0) - (needsAttention(a) ? 1 : 0)
      if (attnDelta !== 0) return attnDelta
      switch (sortMode) {
        case 'oldest':
          return (
            new Date(a.lastMessageAt).getTime() -
              new Date(b.lastMessageAt).getTime() || a.id.localeCompare(b.id)
          )
        case 'unread': {
          const d = b.unread - a.unread
          return d !== 0 ? d : byRecent(a, b)
        }
        case 'status': {
          const d = statusRank(a) - statusRank(b)
          return d !== 0 ? d : byRecent(a, b)
        }
        case 'recent':
        default:
          return byRecent(a, b)
      }
    })
  }, [
    conversations,
    search,
    sourceFilter,
    typeFilter,
    statusFilter,
    reasonFilter,
    sortMode,
    awaitingReply,
    isMuted,
    showMuted,
    activeId,
    localMessages,
  ])

  // When the channel-type filter changes, drop any selected sources that no
  // longer belong to a visible type, so stale selections can't hide everything.
  useEffect(() => {
    if (typeFilter.size === 0) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSourceFilter((prev) => {
      if (prev.size === 0) return prev
      const valid = new Set(
        conversations
          .filter((c) => typeFilter.has(c.channelType))
          .map((c) => c.channelId),
      )
      const next = new Set([...prev].filter((id) => valid.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [typeFilter, conversations])

  const unreadTotal = useMemo(
    () => conversations.reduce((n, c) => n + (c.unread > 0 ? 1 : 0), 0),
    [conversations],
  )

  // Keep the selection consistent with the current filter.
  useEffect(() => {
    const isDesktop =
      typeof window !== 'undefined' &&
      window.matchMedia('(min-width: 768px)').matches
    const stillVisible =
      activeId !== null && filtered.some((c) => c.id === activeId)
    /* eslint-disable react-hooks/set-state-in-effect */
    if (activeId !== null && !stillVisible) {
      setActiveId(isDesktop && filtered.length > 0 ? filtered[0].id : null)
      return
    }
    if (activeId === null && isDesktop && filtered.length > 0) {
      setActiveId(filtered[0].id)
    }
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [activeId, filtered])

  const [pending, startTransition] = useTransition()
  const [statusPending, startStatusTransition] = useTransition()

  // `optionValue` is either 'auto', a plain status, or 'not_liquid:<reason>'.
  function changeStatus(conversationId: string, optionValue: string) {
    let status: LeadStatus | 'auto' = 'auto'
    let reason: NotLiquidReason | null = null
    if (optionValue !== 'auto') {
      const opt = LEAD_STATUS_OPTIONS.find((o) => o.value === optionValue)
      if (opt) {
        status = opt.status
        reason = opt.reason ?? null
      } else {
        status = optionValue as LeadStatus
      }
    }
    startStatusTransition(async () => {
      const res = await setLeadStatusAction(conversationId, status, reason)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Mark a thread as "no reply needed" (or restore it). Optimistically stamps the
  // local override so the badge/sorting/reminders update instantly, then persists.
  function dismissReply(conversationId: string, clear = false) {
    setDismissedOverrides((prev) => {
      const next = { ...prev }
      if (clear) delete next[conversationId]
      else next[conversationId] = Date.now()
      return next
    })
    // Don't nag again about a thread we just dismissed.
    reminderRef.current.lastReminded.set(conversationId, Date.now())
    startStatusTransition(async () => {
      const res = await dismissReplyReminderAction(conversationId, clear)
      if (!res.ok) {
        toast.error(res.message)
        // Roll back the optimistic override on failure.
        setDismissedOverrides((prev) => {
          const next = { ...prev }
          delete next[conversationId]
          return next
        })
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Mute (silence) or unmute a contact, optimistically. Muted threads send no
  // notifications and are hidden from the default list.
  function toggleMute(conversationId: string, muted: boolean) {
    setMutedOverrides((prev) => ({ ...prev, [conversationId]: muted }))
    if (muted) reminderRef.current.lastReminded.set(conversationId, Date.now())
    startStatusTransition(async () => {
      const res = await setConversationMutedAction(conversationId, muted)
      if (!res.ok) {
        toast.error(res.message)
        // Roll back the optimistic override on failure.
        setMutedOverrides((prev) => {
          const next = { ...prev }
          delete next[conversationId]
          return next
        })
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Turn the AI manager-assistant on/off for the active conversation. When it's
  // switched on, the assistant re-reads the thread and leads from the next
  // inbound message; when the manager types a manual reply the server flips it
  // back off automatically (human takeover).
  function toggleAi(conversationId: string, enabled: boolean) {
    setAiOverrides((prev) => ({ ...prev, [conversationId]: enabled }))
    startStatusTransition(async () => {
      const res = await toggleConversationAiAction(conversationId, enabled)
      if (!res.ok) {
        toast.error(res.message)
        setAiOverrides((prev) => {
          const next = { ...prev }
          delete next[conversationId]
          return next
        })
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  // Open the hand-off dialog for a conversation, resetting the picker/note.
  function openTransfer(conversationId: string) {
    setTransferForId(conversationId)
    setTransferTo('')
    setTransferNote('')
  }

  // Submit the hand-off. On success the thread leaves this manager's inbox, so
  // we close it and refresh the server data.
  function submitTransfer() {
    if (!transferForId || !transferTo) {
      toast.error('Выберите менеджера для передачи.')
      return
    }
    const convId = transferForId
    setTransferPending(true)
    startStatusTransition(async () => {
      const res = await transferConversationAction(
        convId,
        transferTo,
        transferNote.trim() || undefined,
      )
      setTransferPending(false)
      if (!res.ok) {
        toast.error(res.message)
        return
      }
      toast.success(res.message)
      setTransferForId(null)
      if (activeId === convId) setActiveId(null)
      router.refresh()
    })
  }

  // Create a Yandex Telemost meeting and send the join link into the active
  // conversation via its own channel (handled server-side).
  function startVideoMeeting() {
    if (!activeId || meetingPending) return
    const convId = activeId
    setMeetingPending(true)
    startStatusTransition(async () => {
      const res = await createMeetingAction(convId)
      setMeetingPending(false)
      if (!res.ok) {
        // If the meeting was created but delivery failed, offer the link so it
        // isn't lost.
        if (res.joinUrl) {
          navigator.clipboard?.writeText(res.joinUrl).catch(() => {})
          toast.error(`${res.message} Ссылка скопирована в буфер обмена.`)
        } else {
          toast.error(res.message)
        }
        return
      }
      toast.success(res.message)
      router.refresh()
    })
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLocalMessages(messagesByConversation)
    // The fresh props carry only the most-recent slice again, so any previously
    // loaded older history is gone — reset the "nothing older" flags so the
    // load-older control reappears where applicable.
    setNoOlder({})
  }, [messagesByConversation])

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  )
  const thread = activeId ? (localMessages[activeId] ?? []) : []

  // Is the AI currently leading the open thread? Under global-lead mode the AI
  // leads whenever the master switch is on AND the thread isn't paused. An
  // optimistic override (from the inbox toggle) wins so the UI reacts instantly.
  const activeAiLed = useMemo(() => {
    if (!active) return false
    const override = aiOverrides[active.id]
    if (override !== undefined) return override
    return aiMasterEnabled && !active.aiPaused
  }, [active, aiOverrides, aiMasterEnabled])

  // Leads the AI just judged ready and handed off to a human («Ликвид»). Drives
  // the inbox banner + list highlight until the manager opens each thread.
  const pendingHandoffs = useMemo(
    () =>
      conversations.filter(
        (c) => c.aiHandoffPending && c.id !== activeId,
      ),
    [conversations, activeId],
  )

  // Auto-scroll the thread to the newest message (and as the visitor's live
  // typing draft grows, so the preview stays in view).
  const activeTypingDraft =
    activeId && typingByConv[activeId] ? typingByConv[activeId].draft : ''
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ block: 'end' })
  }, [activeId, thread.length, activeTypingDraft])

  // NOTE: The outbound "agent is typing" indicator (a server action fired on
  // every keystroke) was removed for performance — a network round-trip per
  // character made the composer feel laggy. Typing is now purely local.

  // Live "visitor is typing" state for the open thread (auto-expired by sweep).
  const activeTyping =
    activeId && typingByConv[activeId] ? typingByConv[activeId] : null

  // Live presence for the open thread (live-chat visitors only).
  const activePresence =
    activeId && presenceByConv[activeId]
      ? presenceByConv[activeId].state
      : null

  // Opening a conversation with unread messages marks it read on our side and
  // (for Telegram/WhatsApp) sends read receipts so the contact sees blue ticks.
  // The unread===0 guard makes this fire once per opened thread.
  useEffect(() => {
    if (!activeId) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv || conv.channelType === 'livechat' || conv.unread === 0) return
    void markConversationReadAction(activeId)
  }, [activeId, conversations])

  // Opening a thread the AI handed off («Ликвид») acknowledges it. The banner
  // and list highlight already exclude the active thread, so it clears visually
  // the instant it's opened �� here we only clear the SERVER flag so it doesn't
  // return on refresh. A ref guard keeps this to one call per opened handoff.
  useEffect(() => {
    if (!activeId) return
    const conv = conversations.find((c) => c.id === activeId)
    if (!conv?.aiHandoffPending || ackedHandoffsRef.current[activeId]) return
    ackedHandoffsRef.current[activeId] = true
    void acknowledgeAiHandoffAction(activeId)
  }, [activeId, conversations])

  // Called by the composer with the trimmed text. The composer owns the draft
  // and clears its own input after invoking this.
  function handleSend(text: string) {
    if (!activeId) return
    const body = text.trim()
    if (!body) return
    // While the AI is leading this thread, manual sends are blocked. Nudge the
    // manager to pause the AI first (the AI button vibrates as the hint).
    if (activeAiLed) {
      pulseAiButton()
      toast.error('ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.')
      return
    }
    const replyTo = replyTarget
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: activeId,
      direction: 'out',
      body,
      author: currentUser,
      createdAt: new Date().toISOString(),
      status: 'sent',
      ...(replyTo
        ? {
            replyTo: {
              id: replyTo.id,
              author: replyTo.author,
              body: replyTo.body,
              ...(replyTo.mediaType ? { mediaType: replyTo.mediaType } : {}),
            },
          }
        : {}),
    }
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: [...(prev[activeId] ?? []), optimistic],
    }))
    setReplyTarget(null)
    startTransition(async () => {
      const res =
        replyTo && active?.channelType === 'telegram'
          ? await replyMessageAction(activeId, replyTo.id, body)
          : await sendMessageAction(activeId, body)
      if (!res.ok) toast.error(res.message)
    })
  }

  /** Set (or clear) the operator's emoji reaction on a message, optimistically. */
  function reactTo(message: Message, emoji: string) {
    if (!activeId) return
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((m) => {
        if (m.id !== message.id) return m
        const others = (m.reactions ?? []).filter((r) => !r.fromMe)
        const reactions = emoji ? [...others, { emoji, fromMe: true }] : others
        return { ...m, reactions: reactions.length ? reactions : undefined }
      }),
    }))
    startTransition(async () => {
      const res = await reactMessageAction(message.id, emoji)
      if (!res.ok) toast.error(res.message)
    })
  }

  /** Soft-delete a message (revoke in Telegram), optimistically. */
  function deleteMessage(message: Message) {
    if (!activeId) return
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: (prev[activeId] ?? []).map((m) =>
        m.id === message.id
          ? {
              ...m,
              body: '',
              deletedAt: new Date().toISOString(),
              reactions: undefined,
            }
          : m,
      ),
    }))
    startTransition(async () => {
      const res = await deleteMessageAction(message.id)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  /** Forward a message to another Telegram conversation. */
  function forwardMessage(message: Message, toConversationId: string) {
    startTransition(async () => {
      const res = await forwardMessageAction(message.id, toConversationId)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  /** Copy a message's text to the clipboard. */
  function copyMessageText(message: Message) {
    navigator.clipboard
      ?.writeText(message.body)
      .then(() => toast.success('Текст скопирован'))
      .catch(() => toast.error('Не удалось скопировать'))
  }

  function sendSticker(sticker: StickerItem) {
    if (!activeId) return
    const optimistic: Message = {
      id: `tmp_${Date.now()}`,
      conversationId: activeId,
      direction: 'out',
      body: sticker.emoji || '[Стикер]',
      author: currentUser,
      createdAt: new Date().toISOString(),
      status: 'sent',
      mediaType: 'sticker',
      mediaMime: sticker.mime,
    }
    setLocalMessages((prev) => ({
      ...prev,
      [activeId]: [...(prev[activeId] ?? []), optimistic],
    }))
    startTransition(async () => {
      const res = await sendStickerAction(activeId, sticker)
      if (!res.ok) toast.error(res.message)
    })
  }

  // Attach + send a file on a WhatsApp or VK conversation. The bytes are
  // uploaded provider-side (through the account's proxy); on success the realtime
  // insert (or refresh) shows the new message with its media bubble.
  function handleSendMediaFile(file: File, caption: string) {
    if (!activeId) return
    const channelType = active?.channelType
    if (channelType !== 'whatsapp' && channelType !== 'vk') return
    const fd = new FormData()
    fd.append('file', file)
    const trimmed = caption.trim()
    if (trimmed) fd.append('caption', trimmed)
    startTransition(async () => {
      const res =
        channelType === 'vk'
          ? await sendVkMediaAction(activeId, fd)
          : await sendWhatsappMediaAction(activeId, fd)
      if (!res.ok) {
        toast.error(res.message)
      } else {
        toast.success(res.message)
        router.refresh()
      }
    })
  }

  // Clear any pending reply when switching conversations.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReplyTarget(null)
  }, [activeId])

  // Other Telegram conversations a message can be forwarded into.
  const forwardTargets: ForwardTarget[] = useMemo(
    () =>
      conversations
        .filter((c) => c.channelType === 'telegram' && c.id !== activeId)
        .map((c) => ({ id: c.id, name: c.contactName })),
    [conversations, activeId],
  )

  // Channel types that actually have chats — drives whether the "Тип" filter
  // menu is worth showing at all.
  const availableTypes = (
    ['telegram', 'whatsapp', 'livechat', 'max', 'vk'] as ChannelType[]
  ).filter((t) => typeCounts[t] > 0)

  const hasActiveFilters =
    typeFilter.size > 0 ||
    sourceFilter.size > 0 ||
    statusFilter.size > 0 ||
    reasonFilter.size > 0

  const clearFilters = useCallback(() => {
    setTypeFilter(new Set())
    setSourceFilter(new Set())
    setStatusFilter(new Set())
    setReasonFilter(new Set())
  }, [])

  const activeStatusValue =
    active && active.statusManual
      ? leadStatusOptionValue(active.status, active.statusDetail)
      : 'auto'

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-card">
      {/* ------------------------------------------------------------------ */}
      {/* AI hand-off banner — leads the AI promoted to «Ликвид» and handed   */}
      {/* to a human. Click to jump to the newest; opening a thread clears it. */}
      {/* ------------------------------------------------------------------ */}
      {pendingHandoffs.length > 0 ? (
        <button
          type="button"
          onClick={() => setActiveId(pendingHandoffs[0].id)}
          className="flex shrink-0 items-center gap-2.5 border-b border-emerald-500/30 bg-emerald-500/10 px-4 py-2.5 text-left text-sm text-emerald-700 transition-colors hover:bg-emerald-500/15 dark:text-emerald-300"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-emerald-50">
            <Sparkles className="size-3.5" />
          </span>
          <span className="flex-1 font-medium">
            {pendingHandoffs.length === 1
              ? `ИИ передал лид «${pendingHandoffs[0].contactName}» — готов к работе (Ликвид).`
              : `ИИ передал ${pendingHandoffs.length} лид(ов) — готовы к работе (Ликвид).`}
          </span>
          <span className="shrink-0 rounded-full bg-emerald-500 px-2.5 py-0.5 text-xs font-semibold text-emerald-50">
            Открыть
          </span>
        </button>
      ) : null}

      <div className="relative flex min-h-0 flex-1 overflow-hidden">
      {/* ------------------------------------------------------------------ */}
      {/* Conversation list                                                  */}
      {/* ------------------------------------------------------------------ */}
      <div
        className={cn(
          'flex w-full flex-col border-r border-border md:w-[340px] md:shrink-0',
          active && 'hidden md:flex',
        )}
      >
        {/* Header */}
        <div className="flex flex-col gap-2.5 border-b border-border px-3 py-3">
          <div className="flex items-center justify-between gap-2 px-1">
            <div className="flex items-center gap-2">
              <h2 className="text-base font-semibold tracking-tight">Чаты</h2>
              {unreadTotal > 0 ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-semibold text-primary-foreground">
                  {unreadTotal}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <SyncBadge state={syncState} />
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Фильтры и сортировка"
                    >
                      <SlidersHorizontal className="size-4" />
                    </Button>
                  }
                />
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>Сортировка</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={sortMode}
                    onValueChange={(v) =>
                      setSortMode((v as SortMode) ?? 'recent')
                    }
                  >
                    <DropdownMenuRadioItem value="recent">
                      Сначала новые
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="oldest">
                      Сначала старые
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="unread">
                      По непрочитанным
                    </DropdownMenuRadioItem>
                    <DropdownMenuRadioItem value="status">
                      По статусу
                    </DropdownMenuRadioItem>
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по диалогам и сообщениям"
                  className="h-9 rounded-full border-transparent bg-muted pl-9 text-sm focus-visible:bg-card"
                  aria-label="Поиск по диалогам и сообщениям"
            />
            {search ? (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                aria-label="Очистить поиск"
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>

          {/* Autopilot master switch (links to the full rule builder). Only
              rendered when the inbox page managed to read autopilot status. */}
          {autopilot ? (
            <AutopilotToggle
              initialEnabled={autopilot.enabled}
              enabledCount={autopilot.enabledCount}
            />
          ) : null}

          {/* Multi-select filter bar: hover-open menus with checkboxes. An empty
              selection means "no filter". Sources is shown only when more than
              one source is connected; channel type only when several types are
              present. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {availableTypes.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  openOnHover
                  delay={120}
                  render={
                    <FilterChip
                      label="Тип"
                      count={typeFilter.size}
                      active={typeFilter.size > 0}
                    />
                  }
                />
                <DropdownMenuContent align="start" className="w-52">
                  <DropdownMenuLabel>Тип канала</DropdownMenuLabel>
                  {availableTypes.map((t) => (
                    <DropdownMenuCheckboxItem
                      key={t}
                      checked={typeFilter.has(t)}
                      onCheckedChange={() => toggleType(t)}
                      closeOnClick={false}
                    >
                      <span className="flex flex-1 items-center gap-2">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            CHANNEL_VISUAL[t].dot,
                          )}
                        />
                        {CHANNEL_VISUAL[t].short}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {typeCounts[t]}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            {sources.length > 1 ? (
              <DropdownMenu>
                <DropdownMenuTrigger
                  openOnHover
                  delay={120}
                  render={
                    <FilterChip
                      label="Источники"
                      count={sourceFilter.size}
                      active={sourceFilter.size > 0}
                    />
                  }
                />
                <DropdownMenuContent align="start" className="w-60">
                  <DropdownMenuLabel>Источники</DropdownMenuLabel>
                  {sources.map((s) => (
                    <DropdownMenuCheckboxItem
                      key={s.id}
                      checked={sourceFilter.has(s.id)}
                      onCheckedChange={() => toggleSource(s.id)}
                      closeOnClick={false}
                    >
                      <span className="flex flex-1 items-center gap-2">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            CHANNEL_VISUAL[s.type].dot,
                          )}
                        />
                        <span className="truncate">{s.label}</span>
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {s.count}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            ) : null}

            <DropdownMenu>
              <DropdownMenuTrigger
                openOnHover
                delay={120}
                render={
                  <FilterChip
                    label="Статусы"
                    count={statusFilter.size}
                    active={statusFilter.size > 0}
                  />
                }
              />
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuLabel>Статусы</DropdownMenuLabel>
                {LEAD_STATUS_ORDER.map((s) => (
                  <Fragment key={s}>
                    <DropdownMenuCheckboxItem
                      checked={statusFilter.has(s)}
                      onCheckedChange={() => toggleStatus(s)}
                      closeOnClick={false}
                    >
                      <span className="flex flex-1 items-center gap-2">
                        <span
                          className={cn(
                            'size-2 rounded-full',
                            LEAD_STATUS_VISUAL[s].dot,
                          )}
                        />
                        {LEAD_STATUS_META[s].label}
                        <span className="ml-auto text-[10px] text-muted-foreground">
                          {statusCounts[s]}
                        </span>
                      </span>
                    </DropdownMenuCheckboxItem>
                    {/* «Не ликвид» reason refinements (Гео / -18 / NA / TRASH) */}
                    {s === 'not_liquid'
                      ? NOT_LIQUID_REASON_ORDER.map((r) => (
                          <DropdownMenuCheckboxItem
                            key={r}
                            checked={reasonFilter.has(r)}
                            onCheckedChange={() => toggleReason(r)}
                            closeOnClick={false}
                            className="pl-8"
                          >
                            <span className="flex flex-1 items-center gap-2 text-xs">
                              {NOT_LIQUID_REASON_META[r].label}
                              <span className="ml-auto text-[10px] text-muted-foreground">
                                {reasonCounts[r]}
                              </span>
                            </span>
                          </DropdownMenuCheckboxItem>
                        ))
                      : null}
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {mutedCount > 0 ? (
              <button
                type="button"
                aria-pressed={showMuted}
                onClick={() => setShowMuted((v) => !v)}
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors',
                  showMuted
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:bg-muted',
                )}
                title={
                  showMuted
                    ? 'Скрыть заглушённые контакты'
                    : 'Показать заглушённые контакты'
                }
              >
                <BellOff className="size-3" />
                {showMuted ? 'Скрыть заглушённые' : 'Заглушённые'}
                <span className="text-[10px] opacity-60">{mutedCount}</span>
              </button>
            ) : null}

            {hasActiveFilters ? (
              <button
                type="button"
                onClick={clearFilters}
                className="flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <X className="size-3" />
                Сбросить
              </button>
            ) : null}
          </div>
        </div>

        {/* List (virtualized — only near-viewport rows are mounted; see VirtualList) */}
        {filtered.length === 0 ? (
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {conversations.length === 0
                ? 'Пока нет диалогов.'
                : 'Ничего не найдено по фильтрам.'}
            </p>
          </div>
        ) : (
          <VirtualList
            items={filtered}
            getItemKey={(c) => c.id}
            estimateSize={76}
            className="scrollbar-thin min-h-0 flex-1 px-1.5 py-1.5"
            renderItem={(c) => (
              <ContextMenu key={c.id}>
                <ContextMenuTrigger
                  render={
                    <button
                      type="button"
                      onClick={() => setActiveId(c.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-left transition-colors hover:bg-muted/60',
                        activeId === c.id
                          ? 'bg-secondary hover:bg-secondary'
                          : '',
                        c.aiHandoffPending && activeId !== c.id
                          ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-500/40 hover:bg-emerald-500/15'
                          : '',
                      )}
                    />
                  }
                >
                  <ContactAvatar
                    name={c.contactName}
                    channel={c.channelType}
                    channelId={c.channelId}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p
                        className={cn(
                          'flex min-w-0 items-center gap-1 truncate text-sm',
                          c.unread > 0 ? 'font-semibold' : 'font-medium',
                        )}
                      >
                        {isMuted(c) ? (
                          <BellOff className="size-3 shrink-0 text-muted-foreground" />
                        ) : null}
                        {presenceByConv[c.id] ? (
                          <PresenceDot state={presenceByConv[c.id].state} />
                        ) : null}
                        <Highlight text={c.contactName} query={search} />
                        {visitorTag(c) ? (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] font-medium tabular-nums text-muted-foreground">
                            {visitorTag(c)}
                          </span>
                        ) : null}
                      </p>
                      <span
                        className={cn(
                          'shrink-0 text-[11px]',
                          c.unread > 0
                            ? 'font-medium text-primary'
                            : 'text-muted-foreground',
                        )}
                      >
                        {listStamp(c.lastMessageAt)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center justify-between gap-2">
                      {typingByConv[c.id] ? (
                        <p className="truncate text-xs font-medium text-primary">
                          печатает…
                        </p>
                      ) : (
                        <p
                          className={cn(
                            'truncate text-xs',
                            c.unread > 0
                              ? 'text-foreground/80'
                              : 'text-muted-foreground',
                          )}
                        >
                          <Highlight text={c.lastMessage} query={search} />
                        </p>
                      )}
                      {c.unread > 0 ? (
                        <span className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold text-primary-foreground">
                          {c.unread}
                        </span>
                      ) : awaitingReply.get(c.id)?.waiting ? (
                        <span className="flex h-5 shrink-0 items-center gap-1 rounded-full bg-amber-500/15 px-1.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                          <Reply className="size-3" />
                          ждёт ответа
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5">
                      <span
                        className={cn(
                          'size-1.5 rounded-full',
                          LEAD_STATUS_VISUAL[c.status].dot,
                        )}
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {LEAD_STATUS_META[c.status].label}
                        {!c.statusManual ? ' · авто' : ''}
                      </span>
                      <SourceChip
                        conversation={c}
                        size="xs"
                        className="ml-auto max-w-[45%]"
                      />
                    </div>
                  </div>
                </ContextMenuTrigger>

                <ContextMenuContent>
                  <ContextMenuLabel>{c.contactName}</ContextMenuLabel>
                  <ContextMenuItem
                    onClick={() => {
                      setActiveId(c.id)
                      setDetailsOpen(true)
                    }}
                  >
                    <Info className="size-4" />
                    Данные и источник
                  </ContextMenuItem>
                  <ContextMenuSub>
                    <ContextMenuSubTrigger>
                      <Tag className="size-4" />
                      Статус лида
                    </ContextMenuSubTrigger>
                    <ContextMenuSubContent>
                      <ContextMenuRadioGroup
                        value={
                          c.statusManual
                            ? leadStatusOptionValue(c.status, c.statusDetail)
                            : 'auto'
                        }
                        onValueChange={(v) => changeStatus(c.id, v ?? 'auto')}
                      >
                        <StatusRadioItems Item={ContextMenuRadioItem} />
                      </ContextMenuRadioGroup>
                    </ContextMenuSubContent>
                  </ContextMenuSub>
                  <ContextMenuSeparator />
                  {awaitingReply.get(c.id)?.waiting ? (
                    <ContextMenuItem onClick={() => dismissReply(c.id)}>
                      <Check className="size-4" />
                      Не требует ответа
                    </ContextMenuItem>
                  ) : c.unread === 0 &&
                    (dismissedOverrides[c.id] || c.replyDismissedAt) ? (
                    <ContextMenuItem onClick={() => dismissReply(c.id, true)}>
                      <Reply className="size-4" />
                      Вернуть в ожидающие
                    </ContextMenuItem>
                  ) : null}
                  {isMuted(c) ? (
                    <ContextMenuItem onClick={() => toggleMute(c.id, false)}>
                      <Bell className="size-4" />
                      Включить уведомления
                    </ContextMenuItem>
                  ) : (
                    <ContextMenuItem onClick={() => toggleMute(c.id, true)}>
                      <BellOff className="size-4" />
                      Заглушить контакт
                    </ContextMenuItem>
                  )}
                    {transferTargets.length > 0 ? (
                      <>
                        <ContextMenuSeparator />
                        <ContextMenuItem onClick={() => openTransfer(c.id)}>
                          <UserPlus className="size-4" />
                          Передать менеджеру
                        </ContextMenuItem>
                      </>
                    ) : null}
                  </ContextMenuContent>
                </ContextMenu>
            )}
          />
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Thread                                                             */}
      {/* ------------------------------------------------------------------ */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col',
          !active && 'hidden md:flex',
        )}
      >
        {active ? (
          <>
            {/* Thread header */}
            <div className="flex h-14 items-center gap-3 border-b border-border px-3 sm:px-4">
              <Button
                variant="ghost"
                size="icon-sm"
                className="md:hidden"
                onClick={() => setActiveId(null)}
                aria-label="Назад к списку"
              >
                <ArrowLeft className="size-4" />
              </Button>
              <button
                type="button"
                onClick={() => setDetailsOpen(true)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-label="Открыть данные о контакте"
              >
                <ContactAvatar
                  name={active.contactName}
                  channel={active.channelType}
                  channelId={active.channelId}
                />
                <div className="flex min-w-0 flex-col gap-0.5">
                  <p className="flex items-center gap-2 truncate text-sm font-semibold">
                    {active.contactName}
                    {visitorTag(active) ? (
                      <span className="shrink-0 rounded bg-muted px-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                        {visitorTag(active)}
                      </span>
                    ) : null}
                    {activePresence ? (
                      <PresenceBadge state={activePresence} />
                    ) : null}
                  </p>
                  <div className="flex min-w-0 items-center gap-1.5">
                    <SourceChip conversation={active} size="xs" />
                  </div>
                </div>
              </button>

              <div className="flex items-center gap-1.5">
                <Button
                  variant={activeAiLed ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => toggleAi(active.id, !activeAiLed)}
                  disabled={statusPending}
                  aria-pressed={activeAiLed}
                  title={
                    activeAiLed
                      ? 'ИИ ведёт этот диалог. Нажмите, чтобы отключить и ответить самому.'
                      : 'Включить ИИ: он проанализирует переписку и продолжит общение.'
                  }
                  className={cn(
                    'gap-1.5',
                    aiButtonPulse && 'animate-shake ring-2 ring-primary',
                  )}
                >
                  <Sparkles className="size-4" />
                  <span className="hidden sm:inline">
                    {activeAiLed ? 'ИИ ведёт' : 'ИИ'}
                  </span>
                </Button>
                <StatusChip
                  status={active.status}
                  auto={!active.statusManual}
                  className="hidden sm:inline-flex"
                />
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={() => setDetailsOpen((v) => !v)}
                  aria-label="Данные о контакте"
                  className="hidden md:inline-flex"
                >
                  <Info className="size-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Действия с диалогом"
                      >
                        <MoreVertical className="size-4" />
                      </Button>
                    }
                  />
                  <DropdownMenuContent align="end" className="w-52">
                    <DropdownMenuLabel>Статус лида</DropdownMenuLabel>
                    <DropdownMenuRadioGroup
                      value={activeStatusValue}
                      onValueChange={(v) => changeStatus(active.id, v ?? 'auto')}
                    >
                      <StatusRadioItems
                        Item={
                          DropdownMenuRadioItem as unknown as typeof ContextMenuRadioItem
                        }
                      />
                    </DropdownMenuRadioGroup>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setDetailsOpen(true)}>
                      <Info className="size-4" />
                      Данные и источник
                    </DropdownMenuItem>
                    {transferTargets.length > 0 ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onClick={() => openTransfer(active.id)}>
                          <UserPlus className="size-4" />
                          Передать менеджеру
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>

            {/* Messages */}
            <div
              ref={messagesScrollRef}
              className="scrollbar-thin min-h-0 flex-1 overflow-y-auto bg-muted/20 px-3 py-4 sm:px-6"
              style={{
                backgroundImage:
                  'radial-gradient(color-mix(in oklch, var(--foreground) 5%, transparent) 1px, transparent 1px)',
                backgroundSize: '22px 22px',
              }}
            >
              <div className="mx-auto flex max-w-3xl flex-col gap-1">
                {/* Older-history loader: shown only when the thread was truncated
                    to the most-recent slice and there may be more to fetch. */}
                {activeId && thread.length >= 300 && !noOlder[activeId] ? (
                  <div className="mb-2 flex justify-center">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={handleLoadOlder}
                      disabled={loadingOlder}
                      className="gap-1.5 text-xs text-muted-foreground"
                    >
                      {loadingOlder ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <ChevronUp className="size-3.5" />
                      )}
                      Загрузить ранние сообщения
                    </Button>
                  </div>
                ) : null}
                {thread.map((m, i) => {
                  const prev = thread[i - 1]
                  const showDay =
                    !prev || dayLabel(prev.createdAt) !== dayLabel(m.createdAt)
                  const isOut = m.direction === 'out'
                  const prevSameSide =
                    prev && prev.direction === m.direction && !showDay
                  return (
                    <div key={m.id}>
                      {showDay ? (
                        <div className="my-3 flex justify-center">
                          <span className="rounded-full bg-card/90 px-2.5 py-0.5 text-[10px] font-medium text-muted-foreground shadow-sm ring-1 ring-border/50">
                            {dayLabel(m.createdAt)}
                          </span>
                        </div>
                      ) : null}
                      <div
                        className={cn(
                          'flex',
                          isOut ? 'justify-end' : 'justify-start',
                          prevSameSide ? 'mt-0.5' : 'mt-2',
                        )}
                      >
                        {(() => {
                          const isDeleted = Boolean(m.deletedAt)
                          // Deleted messages KEEP their content; we just append a
                          // marker so nothing is lost. Label reflects who deleted
                          // it (the contact vs. us), defaulting when unknown.
                          const deletedLabel = isDeleted
                            ? m.deletedOrigin === 'self'
                              ? 'Вы удалили это сообщение'
                              : m.deletedOrigin === 'remote'
                                ? 'Удалено собеседником'
                                : 'Сообщение удалено'
                            : null
                          // Stickers render even without a URL (optimistic
                          // outgoing ones fall back to their emoji).
                          const hasMedia = Boolean(
                            m.mediaType &&
                              (m.mediaUrl || m.mediaType === 'sticker'),
                          )
                          // Stickers float free (no bubble chrome); everything
                          // else keeps the normal bubble styling.
                          const bare = m.mediaType === 'sticker'
                          // Hide the text body for stickers (the sticker itself
                          // conveys it) and for synthetic media placeholders.
                          const showBody =
                            m.body &&
                            m.mediaType !== 'sticker' &&
                            !(hasMedia && isMediaPlaceholder(m.body))
                          const canAct = active.channelType === 'telegram'
                          const reactions = m.reactions ?? []

                          const bubble = (
                            <div
                              className={cn(
                                'text-sm',
                                bare
                                  ? ''
                                  : cn(
                                      'px-3 py-2 shadow-sm',
                                      isOut
                                        ? 'rounded-2xl rounded-br-sm bg-primary text-primary-foreground'
                                        : 'rounded-2xl rounded-bl-sm border border-border bg-card text-foreground',
                                    ),
                              )}
                            >
                              {!isOut && m.author && !prevSameSide ? (
                                <p
                                  className={cn(
                                    'mb-0.5 text-[11px] font-semibold',
                                    CHANNEL_VISUAL[active.channelType].accentText,
                                  )}
                                >
                                  {m.author}
                                </p>
                              ) : null}
                              {m.replyTo ? (
                                <div
                                  className={cn(
                                    'mb-1 rounded-md border-l-2 px-2 py-1 text-left text-xs',
                                    isOut
                                      ? 'border-primary-foreground/50 bg-primary-foreground/10'
                                      : 'border-primary/60 bg-muted/60',
                                  )}
                                >
                                  <p className="font-semibold opacity-90">
                                    {m.replyTo.author || 'Сообщение'}
                                  </p>
                                  <p className="truncate opacity-75">
                                    {m.replyTo.body ||
                                      (m.replyTo.mediaType ? '[вложение]' : '')}
                                  </p>
                                </div>
                              ) : null}
                              {hasMedia ? (
                                <div
                                  className={cn(
                                    showBody && !bare ? 'mb-1' : '',
                                    // Dim preserved media when the message was
                                    // deleted, but keep it openable/saveable.
                                    isDeleted ? 'opacity-60' : '',
                                  )}
                                >
                                  <MessageMedia message={m} />
                                </div>
                              ) : null}
                              {deletedLabel ? (
                                <p
                                  className={cn(
                                    'mb-0.5 flex items-center gap-1 text-[11px] font-medium italic',
                                    isOut
                                      ? 'text-primary-foreground/80'
                                      : 'text-muted-foreground',
                                  )}
                                >
                                  <Trash2 className="size-3 shrink-0" />
                                  {deletedLabel}
                                </p>
                              ) : null}
                              <div className="flex flex-wrap items-end justify-end gap-x-2">
                                {showBody ? (
                                  <p
                                    className={cn(
                                      'whitespace-pre-wrap break-words text-left leading-relaxed [overflow-wrap:anywhere]',
                                      isDeleted ? 'italic opacity-60' : '',
                                    )}
                                  >
                                    {m.body}
                                  </p>
                                ) : null}
                                <span
                                  className={cn(
                                    'ml-auto flex shrink-0 items-center gap-0.5 text-[10px] leading-none',
                                    bare
                                      ? 'text-muted-foreground'
                                      : isOut
                                        ? 'text-primary-foreground/70'
                                        : 'text-muted-foreground',
                                  )}
                                >
                                  {m.editedAt ? (
                                    <button
                                      type="button"
                                      onClick={() => setHistoryMessage(m)}
                                      title="Показать историю изменений"
                                      className={cn(
                                        'mr-0.5 flex items-center gap-0.5 rounded px-0.5 italic underline decoration-dotted underline-offset-2 transition-opacity hover:opacity-80',
                                        isOut
                                          ? 'text-primary-foreground/70'
                                          : 'text-muted-foreground',
                                      )}
                                    >
                                      <History className="size-2.5" />
                                      изменено
                                    </button>
                                  ) : null}
                                  {timeShort(m.createdAt)}
                                  {isOut ? <DeliveryTicks status={m.status} /> : null}
                                </span>
                              </div>
                            </div>
                          )

                          return (
                            <div
                              className={cn(
                                'flex max-w-[80%] flex-col gap-1 sm:max-w-[70%]',
                                isOut ? 'items-end' : 'items-start',
                              )}
                            >
                              {canAct ? (
                                <MessageContextMenu
                                  message={m}
                                  forwardTargets={forwardTargets}
                                  onReply={(msg) => setReplyTarget(msg)}
                                  onReact={reactTo}
                                  onCopy={copyMessageText}
                                  onForward={forwardMessage}
                                  onDelete={deleteMessage}
                                >
                                  {bubble}
                                </MessageContextMenu>
                              ) : (
                                bubble
                              )}
                              {isOut && m.status === 'failed' ? (
                                <p className="flex items-start gap-1 text-[11px] leading-snug text-destructive [overflow-wrap:anywhere]">
                                  <AlertCircle className="mt-0.5 size-3 shrink-0" />
                                  <span>
                                    Не отправлено
                                    {m.errorReason ? `: ${m.errorReason}` : '.'}
                                  </span>
                                </p>
                              ) : null}
                              {reactions.length ? (
                                <div
                                  className={cn(
                                    'flex flex-wrap gap-1',
                                    isOut ? 'justify-end' : 'justify-start',
                                  )}
                                >
                                  {reactions.map((r, ri) => (
                                    <button
                                      key={`${r.emoji}_${ri}`}
                                      type="button"
                                      onClick={() =>
                                        canAct &&
                                        reactTo(m, r.fromMe ? '' : r.emoji)
                                      }
                                      className={cn(
                                        'flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-xs ring-1 transition-colors',
                                        r.fromMe
                                          ? 'bg-primary/15 ring-primary/40'
                                          : 'bg-muted ring-border',
                                      )}
                                      aria-label={`Реакция ${r.emoji}`}
                                    >
                                      <span>{r.emoji}</span>
                                    </button>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          )
                        })()}
                      </div>
                    </div>
                  )
                })}
                {activeTyping ? (
                  <div className="flex flex-col items-start gap-1">
                    <div className="flex items-center gap-2 rounded-2xl rounded-bl-md bg-muted px-3 py-2">
                      <span className="inline-flex gap-1" aria-hidden>
                        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.3s]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:-0.15s]" />
                        <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground/60" />
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {activeTyping.name} печатает
                      </span>
                    </div>
                    {activeTyping.draft ? (
                      <div className="max-w-[80%] rounded-2xl rounded-bl-md border border-dashed border-border bg-card px-3 py-2 text-sm italic text-muted-foreground">
                        {activeTyping.draft}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* Reply preview banner */}
            {replyTarget ? (
              <div className="flex items-center gap-2 border-t border-border bg-muted/40 px-3 py-2">
                <Reply className="size-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1 border-l-2 border-primary/60 pl-2">
                  <p className="text-xs font-semibold text-primary">
                    Ответ · {replyTarget.author || 'Сообщение'}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {replyTarget.body ||
                      (replyTarget.mediaType ? '[вложение]' : '')}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-7 shrink-0"
                  onClick={() => setReplyTarget(null)}
                  aria-label="Отменить ответ"
                >
                  <X className="size-4" />
                </Button>
              </div>
            ) : null}

            {/* Composer — isolated component so typing never re-renders the
                whole inbox. Keyed by conversation id so each thread gets its own
                local draft (persisted across switches via draftsRef). */}
            <MessageComposer
              key={active.id}
              conversationId={active.id}
              channelType={active.channelType}
              channelId={active.channelId}
              getInitialDraft={getDraft}
              onPersistDraft={(text) => persistDraft(active.id, text)}
              onSend={handleSend}
              onSendSticker={sendSticker}
              onSendMediaFile={handleSendMediaFile}
              aiLed={activeAiLed}
              onBlockedInteract={() => {
                pulseAiButton()
                toast.error(
                  'ИИ ведёт этот диалог. Отключите ИИ, чтобы ответить самому.',
                )
              }}
              onToggleAi={() => toggleAi(active.id, false)}
              statusPending={statusPending}
              pending={pending}
              quickReplies={quickReplies}
              telemostEnabled={telemostEnabled}
              onStartMeeting={startVideoMeeting}
              meetingPending={meetingPending}
              replyActive={!!replyTarget}
            />
          </>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
            <div className="flex size-14 items-center justify-center rounded-full bg-muted">
              <MessageCircle className="size-6 text-muted-foreground" />
            </div>
            <p className="text-sm font-medium">Выберите диалог</p>
            <p className="max-w-xs text-xs text-muted-foreground">
              Откройте чат слева, чтобы прочитать переписку и ответить. Правый
              клик по диалогу — быстрые действия.
            </p>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Details drawer (overlays the thread)                               */}
      {/* ------------------------------------------------------------------ */}
      {active && detailsOpen ? (
        <button
          type="button"
          className="absolute inset-0 z-10 cursor-default bg-foreground/10 md:hidden"
          aria-label="Закрыть панель данных"
          onClick={() => setDetailsOpen(false)}
        />
      ) : null}
      <aside
        className={cn(
          'absolute inset-y-0 right-0 z-20 w-full max-w-sm border-l border-border bg-card shadow-xl transition-transform duration-200 ease-out md:w-80',
          active && detailsOpen
            ? 'translate-x-0'
            : 'pointer-events-none translate-x-full',
        )}
        aria-hidden={!(active && detailsOpen)}
      >
        {active ? (
          <DetailsPanel
            key={active.id}
            conversation={active}
            onClose={() => setDetailsOpen(false)}
            onStatus={(next) => changeStatus(active.id, next)}
            statusPending={statusPending}
          />
        ) : null}
      </aside>
      </div>

      {/* Hand-off dialog: pick a colleague and optionally leave a note. */}
      <Dialog
        open={transferForId !== null}
        onOpenChange={(open) => {
          if (!open) setTransferForId(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Передать диалог</DialogTitle>
            <DialogDescription>
              Диалог перейдёт выбранному менеджеру и исчезнет из ваших входящих.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-foreground">
                Кому передать
              </span>
              <div className="scrollbar-thin flex max-h-56 flex-col gap-1 overflow-y-auto">
                {transferTargets.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTransferTo(t.id)}
                    className={cn(
                      'flex items-center justify-between rounded-md border px-3 py-2 text-left text-sm transition-colors',
                      transferTo === t.id
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border hover:bg-muted',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Avatar className="size-6">
                        <AvatarFallback className="text-[10px]">
                          {t.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      {t.name}
                    </span>
                    {t.onLunch ? (
                      <span className="text-xs text-muted-foreground">
                        на обеде
                      </span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-foreground">
                Заметка для коллеги (необязательно)
              </span>
              <Textarea
                value={transferNote}
                onChange={(e) => setTransferNote(e.target.value)}
                placeholder="Например: клиент ждёт расчёт по доставке"
                maxLength={500}
                rows={3}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setTransferForId(null)}
              disabled={transferPending}
            >
              Отмена
            </Button>
            <Button
              onClick={submitTransfer}
              disabled={transferPending || !transferTo}
            >
              {transferPending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <UserPlus className="size-4" />
              )}
              Передать
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EditHistoryDialog
        messageId={historyMessage?.id ?? null}
        currentBody={historyMessage?.body ?? ''}
        currentMediaType={historyMessage?.mediaType}
        currentMediaUrl={historyMessage?.mediaUrl}
        onOpenChange={(open) => {
          if (!open) setHistoryMessage(null)
        }}
      />
    </div>
  )
}
