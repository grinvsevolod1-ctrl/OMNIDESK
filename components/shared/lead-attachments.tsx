'use client'

import { useRef, useState, useTransition } from 'react'
import { CircleDot, Loader2, Paperclip, Play, Trash2, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  attachLeadVideoNoteAction,
  deleteLeadAttachmentAction,
  listConversationVideoNotesAction,
  uploadLeadAttachmentsAction,
} from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import type {
  ConversationVideoNote,
  LeadAttachment,
} from '@/lib/data/lead-attachments'
import { APP_TIME_ZONE } from '@/lib/time'
import { cn } from '@/lib/utils'

const MAX_FILES = 10
const MAX_BYTES = 50 * 1024 * 1024

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: APP_TIME_ZONE,
  })
}

const ROLE_LABEL: Record<string, string> = {
  manager: 'менеджер',
  curator: 'куратор',
  admin: 'админ',
}

/**
 * Вложения карточки лида: сетка фото/видео/кружков + загрузка файлов и
 * (для менеджера в контексте диалога) закрепление телеграм-кружка.
 * Виден всем, у кого есть доступ к карточке; удалять может автор и админ.
 */
export function LeadAttachments({
  leadCardId,
  conversationId,
  attachments,
  onChanged,
  currentUserId,
  isAdmin,
}: {
  leadCardId: string
  /** Диалог карточки — включает кнопку «Прикрепить кружок». */
  conversationId?: string | null
  attachments: LeadAttachment[]
  onChanged: (next: LeadAttachment[]) => void
  currentUserId: string
  isAdmin?: boolean
}) {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [viewer, setViewer] = useState<LeadAttachment | null>(null)

  function onFilesPicked(list: FileList | null) {
    if (!list || list.length === 0) return
    const files = Array.from(list)
    if (files.length > MAX_FILES) {
      toast.error(`За раз можно до ${MAX_FILES} файлов`)
      return
    }
    for (const f of files) {
      if (f.size > MAX_BYTES) {
        toast.error(`«${f.name}» больше 50 МБ`)
        return
      }
      if (!f.type.startsWith('image/') && !f.type.startsWith('video/')) {
        toast.error(`«${f.name}»: только фото или видео`)
        return
      }
    }
    const form = new FormData()
    form.set('leadCardId', leadCardId)
    for (const f of files) form.append('files', f)
    startTransition(async () => {
      const res = await uploadLeadAttachmentsAction(form)
      if (res.ok && res.attachments) {
        toast.success(res.message)
        onChanged(res.attachments)
      } else {
        toast.error(res.message)
      }
    })
  }

  function remove(att: LeadAttachment) {
    startTransition(async () => {
      const res = await deleteLeadAttachmentAction({ attachmentId: att.id })
      if (res.ok && res.attachments) {
        toast.success(res.message)
        onChanged(res.attachments)
        if (viewer?.id === att.id) setViewer(null)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-semibold">
          Файлы
          {attachments.length > 0 ? (
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              {attachments.length}
            </span>
          ) : null}
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*"
            multiple
            hidden
            onChange={(e) => {
              onFilesPicked(e.target.files)
              e.target.value = ''
            }}
          />
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            disabled={pending}
            onClick={() => fileInputRef.current?.click()}
          >
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Paperclip className="size-3.5" />
            )}
            Прикрепить
          </Button>
          {conversationId ? (
            <VideoNotePicker
              leadCardId={leadCardId}
              conversationId={conversationId}
              onChanged={onChanged}
            />
          ) : null}
        </div>
      </div>

      {attachments.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2.5 text-xs text-muted-foreground">
          Пока нет файлов. Фото, видео и кружки будут видны менеджеру,
          куратору и админу.
        </p>
      ) : (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {attachments.map((att) => {
            const canDelete = isAdmin || att.authorId === currentUserId
            return (
              <li key={att.id} className="group relative">
                <button
                  type="button"
                  className={cn(
                    'block w-full overflow-hidden border border-border bg-muted/40 transition-opacity hover:opacity-90',
                    att.kind === 'video_note'
                      ? 'aspect-square rounded-full'
                      : 'aspect-square rounded-lg',
                  )}
                  onClick={() => setViewer(att)}
                  aria-label={`Открыть ${
                    att.kind === 'photo'
                      ? 'фото'
                      : att.kind === 'video'
                        ? 'видео'
                        : 'кружок'
                  }`}
                >
                  {att.kind === 'photo' ? (
                    // eslint-disable-next-line @next/next/no-img-element -- стриминговый приватный роут
                    <img
                      src={att.url || '/placeholder.svg'}
                      alt={att.fileName ?? 'Фото'}
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="relative flex size-full items-center justify-center">
                      <video
                        src={att.url}
                        muted
                        playsInline
                        preload="metadata"
                        className={cn(
                          'size-full object-cover',
                          att.kind === 'video_note' && 'rounded-full',
                        )}
                      />
                      <span className="absolute inset-0 flex items-center justify-center bg-black/25">
                        <Play className="size-6 fill-white text-white drop-shadow" />
                      </span>
                    </span>
                  )}
                </button>
                {canDelete ? (
                  <button
                    type="button"
                    className="absolute -right-1.5 -top-1.5 z-10 hidden size-6 items-center justify-center rounded-full bg-destructive text-destructive-foreground shadow-sm group-hover:flex"
                    onClick={() => remove(att)}
                    disabled={pending}
                    aria-label="Удалить вложение"
                  >
                    <Trash2 className="size-3" />
                  </button>
                ) : null}
                <p className="mt-1 truncate text-[10px] leading-tight text-muted-foreground">
                  {att.authorName ?? '—'}
                  {att.authorRole ? ` · ${ROLE_LABEL[att.authorRole]}` : ''}
                </p>
              </li>
            )
          })}
        </ul>
      )}

      {/* Полноэкранный просмотр */}
      {viewer ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/80 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Просмотр вложения"
        >
          <button
            type="button"
            className="absolute inset-0"
            aria-label="Закрыть просмотр"
            onClick={() => setViewer(null)}
          />
          <div className="relative z-10 max-h-full max-w-3xl">
            <Button
              variant="secondary"
              size="icon-sm"
              className="absolute -top-10 right-0"
              onClick={() => setViewer(null)}
              aria-label="Закрыть"
            >
              <X className="size-4" />
            </Button>
            {viewer.kind === 'photo' ? (
              // eslint-disable-next-line @next/next/no-img-element -- стриминговый приватный роут
              <img
                src={viewer.url || '/placeholder.svg'}
                alt={viewer.fileName ?? 'Фото'}
                className="max-h-[80dvh] max-w-full rounded-lg object-contain"
              />
            ) : (
              <video
                src={viewer.url}
                controls
                autoPlay
                playsInline
                className={cn(
                  'max-h-[80dvh] max-w-full object-contain',
                  viewer.kind === 'video_note'
                    ? 'aspect-square rounded-full'
                    : 'rounded-lg',
                )}
              />
            )}
            <p className="mt-2 text-center text-xs text-white/80">
              {viewer.authorName ?? '—'}
              {viewer.authorRole ? ` · ${ROLE_LABEL[viewer.authorRole]}` : ''}
              {' · '}
              {formatDateTime(viewer.createdAt)}
            </p>
          </div>
        </div>
      ) : null}
    </div>
  )
}

/**
 * «Прикрепить кружок»: находит все video_note активного диалога по порядку
 * и закрепляет выбранный за карточкой.
 */
function VideoNotePicker({
  leadCardId,
  conversationId,
  onChanged,
}: {
  leadCardId: string
  conversationId: string
  onChanged: (next: LeadAttachment[]) => void
}) {
  const [open, setOpen] = useState(false)
  const [notes, setNotes] = useState<ConversationVideoNote[] | null>(null)
  const [pending, startTransition] = useTransition()

  function toggle() {
    const next = !open
    setOpen(next)
    if (next && notes === null) {
      startTransition(async () => {
        try {
          setNotes(await listConversationVideoNotesAction(conversationId))
        } catch {
          toast.error('Не удалось найти кружки')
          setNotes([])
        }
      })
    }
  }

  function attach(note: ConversationVideoNote) {
    startTransition(async () => {
      const res = await attachLeadVideoNoteAction({
        leadCardId,
        conversationId,
        messageId: note.messageId,
      })
      if (res.ok && res.attachments) {
        toast.success(res.message)
        onChanged(res.attachments)
        setOpen(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={toggle}
        aria-expanded={open}
        title="Прикрепить кружок из диалога"
      >
        <CircleDot className="size-3.5" />
        Кружок
      </Button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-1.5 w-64 rounded-xl border border-border bg-popover p-2 shadow-lg">
          <p className="px-1 pb-1.5 text-xs font-medium text-muted-foreground">
            Кружки этого диалога
          </p>
          {pending && notes === null ? (
            <p className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              Ищем кружки…
            </p>
          ) : !notes || notes.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              В диалоге нет видео-кружков
            </p>
          ) : (
            <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
              {notes.map((n) => (
                <li key={n.messageId}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors hover:bg-muted disabled:opacity-50"
                    onClick={() => attach(n)}
                    disabled={pending}
                  >
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[10px] font-semibold text-primary">
                      {n.ordinal}
                    </span>
                    <span className="min-w-0">
                      <span className="block font-medium">
                        Кружок №{n.ordinal}
                      </span>
                      <span className="block text-muted-foreground">
                        {n.direction === 'in' ? 'от клиента' : 'наш'} ·{' '}
                        {formatDateTime(n.createdAt)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  )
}
