'use client'

import { memo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Ban,
  Bot,
  Circle,
  Hand,
  Info,
  Loader2,
  Mail,
  MailOpen,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Radio,
  Search,
  Send,
  ShieldCheck,
  Trash2,
  UserRound,
  Video,
  X,
} from 'lucide-react'
import { ChannelIcon } from '@/components/channel-icons'
import type {
  ConversationWithManager,
  ConversationWithSim,
} from '@/app/actions/admin-secret'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { Message } from '@/lib/types'
import {
  CONV_STATUS_LABEL,
  CONV_STATUS_STYLE,
  fmtDay,
  fmtTime,
  highlight,
  initials,
  isComposing,
  MEDIA_CHIP_LABEL,
  SIM_STATE_LABEL,
  STATUS_VALUES,
  TYPE_LABEL,
  type DirFilter,
  type SimInfo,
} from '@/components/admin/secret-console/utils'

/**
 * Presentational thread sub-components for the secret console, extracted from
 * secret-console.tsx to keep the root component focused on state/orchestration.
 * All are driven purely by props (no server actions of their own).
 */

/* --------------------------- Conversation row ------------------------- */

export const ConversationRow = memo(function ConversationRow({
  conversation: c,
  active,
  onSelect,
}: {
  conversation: ConversationWithSim
  active: boolean
  onSelect: (id: string) => void
}) {
  const simDriving = Boolean(c.sim?.active && !c.sim.paused)
  const simPaused = Boolean(c.sim?.active && c.sim.paused)
  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(c.id)}
        className={cn(
          'flex w-full items-start gap-3 border-b border-border/60 p-3 text-left transition-colors hover:bg-muted/50',
          active && 'bg-muted',
        )}
      >
        <div className="relative">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
            {initials(c.contactName)}
          </div>
          <span className="absolute -bottom-1 -right-1 flex size-4.5 items-center justify-center rounded-full border-2 border-card bg-card">
            <ChannelIcon type={c.channelType} className="size-3 rounded-full" />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="truncate text-sm font-medium">{c.contactName}</span>
            <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">
              {fmtTime(c.lastMessageAt)}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <p className="truncate text-xs text-muted-foreground">
              {c.lastMessage || '—'}
            </p>
            {c.unread > 0 && (
              <span className="ml-auto flex size-4.5 shrink-0 items-center justify-center rounded-full bg-primary text-[10px] font-semibold text-primary-foreground tabular-nums">
                {c.unread > 9 ? '9+' : c.unread}
              </span>
            )}
          </div>
          <div className="mt-1 flex items-center gap-1.5">
            {c.contactBlocked && (
              <Ban className="size-3 shrink-0 text-destructive" aria-label="Менеджер заблокирован клиентом" />
            )}
            {simDriving && (
              <span
                className="flex items-center gap-1 rounded bg-chart-2/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground"
                title="Диалог ведёт симулятор"
              >
                <Bot className="size-3" /> Симулятор
              </span>
            )}
            {simPaused && (
              <span
                className="flex items-center gap-1 rounded bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                title="Вы управляете этим диалогом"
              >
                <Hand className="size-3" /> Вы
              </span>
            )}
            <span
              className={cn(
                'rounded px-1.5 py-0.5 text-[10px] font-medium',
                CONV_STATUS_STYLE[c.status] ?? 'bg-muted text-muted-foreground',
              )}
            >
              {CONV_STATUS_LABEL[c.status] ?? c.status}
            </span>
            <span className="truncate text-[10px] text-muted-foreground">
              {c.managerName ?? '—'}
            </span>
          </div>
        </div>
      </button>
    </li>
  )
})

/* ---------------------------- Thread header --------------------------- */

export function ThreadHeader({
  conversation,
  sim,
  managerName,
  pending,
  filterActive,
  onToggleFilter,
  onBack,
  onSetSim,
  onStatus,
  onToggleRead,
  onToggleBlock,
  onEdit,
  onDelete,
}: {
  conversation: ConversationWithManager
  sim: SimInfo
  managerName: string
  pending: boolean
  filterActive: boolean
  onToggleFilter: () => void
  onBack: () => void
  onSetSim: (enabled: boolean) => void
  onStatus: (status: string) => void
  onToggleRead: () => void
  onToggleBlock: () => void
  onEdit: () => void
  onDelete: () => void
}) {
  const blocked = Boolean(conversation.contactBlocked)
  const simActive = Boolean(sim?.active)
  const simDriving = Boolean(sim?.active && !sim.paused)

  return (
    <div className="flex items-center gap-2 border-b border-border p-3">
      <Button
        variant="ghost"
        size="icon"
        className="size-8 md:hidden"
        onClick={onBack}
        aria-label="Назад к списку"
      >
        <ArrowLeft className="size-4" />
      </Button>
      <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
        {initials(conversation.contactName)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-semibold">{conversation.contactName}</span>
          <Badge variant="secondary" className="hidden gap-1 sm:inline-flex">
            <ChannelIcon type={conversation.channelType} className="size-3 rounded-full" />
            {TYPE_LABEL[conversation.channelType] ?? conversation.channelType}
          </Badge>
          {blocked && (
            <Badge variant="destructive" className="gap-1">
              <Ban className="size-3" />
              <span className="hidden sm:inline">Заблокирован</span>
            </Badge>
          )}
        </div>
        <p className="truncate text-xs text-muted-foreground">
          {conversation.contactHandle} · {managerName}
        </p>
      </div>

      {/* Simulator take-over control — only for simulated dialogues. */}
      {simActive && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-2 rounded-md border px-2.5 py-1.5',
            simDriving
              ? 'border-chart-2/40 bg-chart-2/10'
              : 'border-warning/40 bg-warning/10',
          )}
        >
          {simDriving ? (
            <Bot className="size-4 shrink-0 text-foreground" aria-hidden />
          ) : (
            <Hand className="size-4 shrink-0 text-warning" aria-hidden />
          )}
          <div className="hidden min-w-0 flex-col leading-tight sm:flex">
            <span className="text-xs font-medium">
              {simDriving ? 'Ведёт симулятор' : 'Вы управляете'}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {simDriving ? 'вмешайтесь, чтобы взять' : 'симулятор на паузе'}
            </span>
          </div>
          <Switch
            checked={simDriving}
            onCheckedChange={onSetSim}
            disabled={pending}
            aria-label="Передать диалог симулятору"
          />
        </div>
      )}

      {/* Message filter toggle (progressive disclosure). */}
      <Button
        variant={filterActive ? 'default' : 'outline'}
        size="icon"
        className="size-9 shrink-0"
        onClick={onToggleFilter}
        aria-label="Фильтр сообщений"
      >
        <Search className="size-4" />
      </Button>

      {/* Everything else tucked away to keep the header calm. */}
      <Popover>
        <PopoverTrigger
          render={
            <Button variant="outline" size="icon" className="size-9 shrink-0" aria-label="Действия и детали" />
          }
        >
          <MoreHorizontal className="size-4" />
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 space-y-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Статус диалога</Label>
            <Select value={conversation.status} onValueChange={(v) => v && onStatus(v)}>
              <SelectTrigger className="h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_VALUES.map((v) => (
                  <SelectItem key={v} value={v}>
                    {CONV_STATUS_LABEL[v]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending} onClick={onToggleRead}>
              {conversation.unread > 0 ? (
                <>
                  <MailOpen className="size-3.5" /> Прочитано
                </>
              ) : (
                <>
                  <Mail className="size-3.5" /> Непроч.
                </>
              )}
            </Button>
            <Button
              variant={blocked ? 'default' : 'outline'}
              size="sm"
              className="h-8 gap-1.5"
              disabled={pending}
              onClick={onToggleBlock}
            >
              {blocked ? (
                <>
                  <ShieldCheck className="size-3.5" /> Разбл.
                </>
              ) : (
                <>
                  <Ban className="size-3.5" /> Блок
                </>
              )}
            </Button>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={pending} onClick={onEdit}>
              <Pencil className="size-3.5" /> Изменить
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 text-destructive"
              disabled={pending}
              onClick={onDelete}
            >
              <Trash2 className="size-3.5" /> Удалить
            </Button>
          </div>

          {simActive && sim && (
            <>
              <Separator />
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex items-center gap-1.5 font-medium text-foreground">
                  <Info className="size-3.5" /> Детали ведения
                </div>
                {sim.personaName && <p>Персона: {sim.personaName}</p>}
                <p>Стадия: {SIM_STATE_LABEL[sim.state] ?? sim.state}</p>
                <p>{sim.paused ? 'Симулятор отключён — вы ведёте диалог.' : 'Диалог автоматически ведёт симулятор.'}</p>
              </div>
            </>
          )}
        </PopoverContent>
      </Popover>
    </div>
  )
}

/* -------------------------- Thread filter bar ------------------------- */

export function ThreadFilterBar({
  dirFilter,
  onDir,
  search,
  onSearch,
  shown,
  total,
  onClose,
}: {
  dirFilter: DirFilter
  onDir: (d: DirFilter) => void
  search: string
  onSearch: (v: string) => void
  shown: number
  total: number
  onClose: () => void
}) {
  const segments: { value: DirFilter; label: string }[] = [
    { value: 'all', label: 'Все' },
    { value: 'in', label: 'Клиент' },
    { value: 'out', label: 'Менеджер' },
  ]
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 p-2.5">
      <div className="flex items-center rounded-md border border-border bg-card p-0.5">
        {segments.map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => onDir(s.value)}
            className={cn(
              'rounded px-2.5 py-1 text-xs font-medium transition-colors',
              dirFilter === s.value
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="relative min-w-40 flex-1">
        <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder="Поиск по переписке"
          className="h-8 pl-8 text-sm"
        />
      </div>
      <span className="text-xs text-muted-foreground tabular-nums">
        {shown}/{total}
      </span>
      <Button variant="ghost" size="icon" className="size-8" onClick={onClose} aria-label="Скрыть фильтр">
        <X className="size-4" />
      </Button>
    </div>
  )
}

/* ---------------------------- Message bubble -------------------------- */

export const MessageBubble = memo(function MessageBubble({
  message,
  highlightQuery,
  pending,
  onDelete,
}: {
  message: Message
  highlightQuery: string
  pending: boolean
  onDelete: (messageId: string) => void
}) {
  // Admin impersonates the CLIENT: inbound ('in') = "us" → right side.
  const mine = message.direction === 'in'
  const deleted = Boolean(message.deletedAt)
  return (
    <div className={cn('group flex items-end gap-2', mine ? 'justify-end' : 'justify-start')}>
      {mine && !deleted && (
        <button
          type="button"
          onClick={() => onDelete(message.id)}
          disabled={pending}
          aria-label="Удалить сообщение"
          className="mb-1 opacity-0 transition-opacity group-hover:opacity-100"
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-3.5 py-2 text-sm shadow-sm',
          mine
            ? 'rounded-br-sm bg-primary text-primary-foreground'
            : 'rounded-bl-sm bg-card text-card-foreground border border-border',
        )}
      >
        <div className="mb-0.5 flex items-center gap-2">
          <span className={cn('flex items-center gap-1 text-[11px] font-medium', mine ? 'text-primary-foreground/80' : 'text-muted-foreground')}>
            <UserRound className="size-3" />
            {message.author || (mine ? 'Клиент' : 'Менеджер')}
          </span>
          <span className={cn('text-[10px]', mine ? 'text-primary-foreground/60' : 'text-muted-foreground')}>
            {fmtDay(message.createdAt)}
          </span>
        </div>
        {deleted ? (
          <p className="italic opacity-70">Сообщение удалено</p>
        ) : (
          <>
            {message.mediaType && (
              <span
                className={cn(
                  'mb-1 inline-flex items-center gap-1 text-xs',
                  mine ? 'text-primary-foreground/80' : 'text-muted-foreground',
                )}
              >
                {message.mediaType === 'video_note' ? (
                  <Circle className="size-3" />
                ) : (
                  <Paperclip className="size-3" />
                )}
                {message.mediaName ?? MEDIA_CHIP_LABEL[message.mediaType] ?? 'Вложение'}
              </span>
            )}
            <p className="whitespace-pre-wrap break-words leading-relaxed">
              {highlight(message.body, highlightQuery)}
            </p>
          </>
        )}
      </div>
      {!mine && (
        <button
          type="button"
          onClick={() => onDelete(message.id)}
          disabled={pending || deleted}
          aria-label="Удалить сообщение"
          className="mb-1 opacity-0 transition-opacity group-hover:opacity-100 disabled:hidden"
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      )}
    </div>
  )
})

/* ------------------------------- Composer ----------------------------- */

export function Composer({
  contactName,
  pending,
  simDriving,
  onIntervene,
  onSend,
  onSendMedia,
}: {
  contactName: string
  pending: boolean
  simDriving: boolean
  onIntervene: () => void
  onSend: (body: string, onDone: () => void) => void
  onSendMedia: (
    file: File,
    caption: string,
    onDone: () => void,
    sendAs?: 'video' | 'video_note',
  ) => void
}) {
  const [body, setBody] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  // When a video is picked we ask HOW to deliver it (обычное видео / кружочек)
  // before sending; this holds the pending video until the choice is made.
  const [pendingVideo, setPendingVideo] = useState<File | null>(null)

  function submit() {
    if (!body.trim() || pending) return
    onSend(body, () => setBody(''))
  }

  // Attach a file "from the client": the current textarea text rides along as
  // the caption, then both are cleared. The input is reset so the same file can
  // be picked again. Videos pause for a delivery-style choice (video vs круг).
  function onFilePicked(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || pending) return
    if (file.type.startsWith('video/')) {
      setPendingVideo(file)
      return
    }
    onSendMedia(file, body, () => setBody(''))
  }

  // Deliver the buffered video with the chosen style, then reset the prompt.
  function sendPendingVideo(sendAs: 'video' | 'video_note') {
    const file = pendingVideo
    if (!file) return
    setPendingVideo(null)
    onSendMedia(file, body, () => setBody(''), sendAs)
  }

  return (
    <div className="border-t border-border p-3">
      {simDriving && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-chart-2/40 bg-chart-2/10 px-3 py-2 text-xs">
          <Bot className="size-4 shrink-0 text-foreground" />
          <span className="flex-1 text-muted-foreground">
            Диалог ведёт симулятор. Отправьте сообщение или нажмите «Вмешаться» — симулятор отключится от этого диалога.
          </span>
          <Button size="sm" variant="outline" className="h-7 gap-1.5" disabled={pending} onClick={onIntervene}>
            <Hand className="size-3.5" /> Вмешаться
          </Button>
        </div>
      )}
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Radio className="size-3.5 text-primary" />
        Вы пишете от имени клиента{' '}
        <span className="font-medium text-foreground">{contactName}</span>
      </div>
      <div className="flex items-end gap-2">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip"
          onChange={onFilePicked}
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="size-11 shrink-0"
          disabled={pending}
          onClick={() => fileInputRef.current?.click()}
          aria-label="Прикрепить файл от имени клиента"
          title="Прикрепить файл"
        >
          <Paperclip className="size-4" />
        </Button>
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !isComposing(e)) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder="Сообщение от клиента… (Enter — отправить, Shift+Enter — перенос)"
          className="max-h-40 min-h-11 flex-1 resize-none"
          rows={1}
        />
        <Button onClick={submit} disabled={pending || !body.trim()} className="h-11 gap-1.5">
          {pending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
          Отправить
        </Button>
      </div>

      <Dialog
        open={pendingVideo !== null}
        onOpenChange={(v) => {
          if (!v) setPendingVideo(null)
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Как отправить видео?</DialogTitle>
            <DialogDescription>
              Кружочек будет доставлен менеджеру как видеосообщение — обрезанный
              круг, как в Telegram и ВК.
            </DialogDescription>
          </DialogHeader>
          <div className="grid grid-cols-2 gap-3 pt-1">
            <button
              type="button"
              onClick={() => sendPendingVideo('video')}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 text-center transition-colors hover:border-primary hover:bg-accent"
            >
              <span className="flex size-12 items-center justify-center rounded-md bg-muted">
                <Video className="size-6 text-foreground" />
              </span>
              <span className="text-sm font-medium">Видео</span>
              <span className="text-xs text-muted-foreground">
                Обычный прямоугольный ролик
              </span>
            </button>
            <button
              type="button"
              onClick={() => sendPendingVideo('video_note')}
              className="flex flex-col items-center gap-2 rounded-lg border border-border bg-card p-4 text-center transition-colors hover:border-primary hover:bg-accent"
            >
              <span className="flex size-12 items-center justify-center rounded-full bg-muted">
                <Circle className="size-6 text-foreground" />
              </span>
              <span className="text-sm font-medium">Кружочек</span>
              <span className="text-xs text-muted-foreground">
                Видеосообщение в круге
              </span>
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}

