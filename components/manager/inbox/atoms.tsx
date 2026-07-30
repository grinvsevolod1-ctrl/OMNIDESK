'use client'

/**
 * Inbox presentational atoms, extracted from inbox-view.tsx: status/presence/
 * source chips, search highlight, contact avatar, the details panel (visitor &
 * source context + lead-status control), the shared lead-status radio items and
 * the message delivery ticks. All are driven purely by props — no InboxView
 * state — so they can be unit-tested and reused in isolation.
 */

import {
  AlertCircle,
  Check,
  CheckCheck,
  Clock,
  Globe,
  Info,
  Link2,
  Loader2,
  MapPin,
  Monitor,
  Tag,
  X,
} from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { ContextMenuRadioItem } from '@/components/ui/context-menu'
import { cn } from '@/lib/utils'
import {
  LEAD_STATUS_META,
  LEAD_STATUS_OPTIONS,
  NOT_LIQUID_REASON_META,
  leadStatusOptionValue,
} from '@/lib/types'
import type {
  ChannelType,
  Conversation,
  ConversationMeta,
  LeadStatus,
  Message,
  NotLiquidReason,
} from '@/lib/types'
import {
  CHANNEL_VISUAL,
  LEAD_STATUS_VISUAL,
  PRESENCE_VISUAL,
  avatarTint,
  dateTime,
  deviceLabel,
  initials,
  shortUrl,
  sourceAccent,
  sourceLabel,
  visitorTag,
  type PresenceState,
} from '@/components/manager/inbox/visual'

/* -------------------------------------------------------------------------- */
/*  Presentational atoms                                                      */
/* -------------------------------------------------------------------------- */

export function StatusChip({
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
export function PresenceDot({ state }: { state: PresenceState }) {
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
export function PresenceBadge({
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
      title="Активн��сть посетителя на сайте в ��еальном времени"
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
export function SourceChip({
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

export function SyncBadge({ state }: { state: 'connecting' | 'live' | 'offline' }) {
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

export function Highlight({ text, query }: { text: string; query: string }) {
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
export function ContactAvatar({
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

export function MetaRows({ meta }: { meta: ConversationMeta }) {
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

export function DetailsPanel({
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

export function StatusRadioItems({ Item }: { Item: typeof ContextMenuRadioItem }) {
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

/**
 * Messenger-style delivery ticks for an outbound message:
 *   sent → single check, delivered → double check, read → blue double check,
 *   failed → warning. Legacy rows (no status) fall back to a single check.
 */
export function DeliveryTicks({ status }: { status?: Message['status'] }) {
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
