'use client'

/**
 * Support entry point shared by every role (rendered in the dashboard header).
 * A single icon opens a dialog where any signed-in user can report a problem or
 * suggest an improvement, attaching any number of screenshots/videos via
 * drag-and-drop, a file picker, or mass paste (Ctrl/Cmd+V). Everything is sent
 * to the owner's Telegram bot by `submitSupportTicketAction`; the author is
 * resolved server-side from the session, so nothing about identity is trusted
 * from the client here.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
} from 'react'
import {
  FileText,
  LifeBuoy,
  Loader2,
  Lightbulb,
  Bug,
  Paperclip,
  Upload,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { submitSupportTicketAction } from '@/app/actions/support'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type SupportKind = 'problem' | 'suggestion'

interface Attachment {
  id: string
  file: File
  /** Object URL for image/video preview; undefined for other types. */
  previewUrl?: string
}

const MAX_ATTACHMENTS = 20

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} КБ`
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`
}

let attachmentSeq = 0

export function SupportDialog() {
  const [open, setOpen] = useState(false)
  const [kind, setKind] = useState<SupportKind>('problem')
  const [description, setDescription] = useState('')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragActive, setDragActive] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const dragDepth = useRef(0)

  // Revoke object URLs on unmount / when attachments change out.
  useEffect(() => {
    return () => {
      attachments.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const addFiles = useCallback((incoming: File[]) => {
    const usable = incoming.filter((f) => f.size > 0)
    if (usable.length === 0) return
    setAttachments((prev) => {
      const room = MAX_ATTACHMENTS - prev.length
      if (room <= 0) {
        toast.error(`Можно приложить не более ${MAX_ATTACHMENTS} файлов.`)
        return prev
      }
      const taken = usable.slice(0, room)
      if (taken.length < usable.length) {
        toast.error(`Добавлены не все: лимит ${MAX_ATTACHMENTS} файлов.`)
      }
      const next = taken.map<Attachment>((file) => {
        const isMedia =
          file.type.startsWith('image/') || file.type.startsWith('video/')
        return {
          id: `att-${attachmentSeq++}`,
          file,
          previewUrl: isMedia ? URL.createObjectURL(file) : undefined,
        }
      })
      return [...prev, ...next]
    })
  }, [])

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((a) => a.id !== id)
    })
  }, [])

  const onInputChange = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(Array.from(e.target.files))
      e.target.value = ''
    },
    [addFiles],
  )

  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData.files)
      if (files.length > 0) {
        e.preventDefault()
        addFiles(files)
      }
    },
    [addFiles],
  )

  const onDrop = useCallback(
    (e: DragEvent) => {
      e.preventDefault()
      dragDepth.current = 0
      setDragActive(false)
      if (e.dataTransfer.files.length > 0) {
        addFiles(Array.from(e.dataTransfer.files))
      }
    },
    [addFiles],
  )

  const onDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault()
    dragDepth.current += 1
    setDragActive(true)
  }, [])

  const onDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault()
    dragDepth.current -= 1
    if (dragDepth.current <= 0) {
      dragDepth.current = 0
      setDragActive(false)
    }
  }, [])

  const resetForm = useCallback(() => {
    setAttachments((prev) => {
      prev.forEach((a) => {
        if (a.previewUrl) URL.revokeObjectURL(a.previewUrl)
      })
      return []
    })
    setDescription('')
    setKind('problem')
  }, [])

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (submitting) return
      setOpen(next)
      if (!next) resetForm()
    },
    [submitting, resetForm],
  )

  const handleSubmit = useCallback(async () => {
    if (description.trim().length < 3) {
      toast.error('Опишите проблему или предложение подробнее.')
      return
    }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.set('kind', kind)
      fd.set('description', description.trim())
      attachments.forEach((a) => fd.append('files', a.file, a.file.name))
      const res = await submitSupportTicketAction(fd)
      if (res.ok) {
        toast.success(
          kind === 'problem'
            ? 'Спасибо! Обращение отправлено.'
            : 'Спасибо за предложение!',
        )
        setOpen(false)
        resetForm()
      } else {
        toast.error(res.error ?? 'Не удалось отправить обращение.')
      }
    } catch {
      toast.error('Не удалось отправить обращение. Попробуйте ещё раз.')
    } finally {
      setSubmitting(false)
    }
  }, [description, kind, attachments, resetForm])

  const totalSize = useMemo(
    () => attachments.reduce((sum, a) => sum + a.file.size, 0),
    [attachments],
  )

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              onClick={() => setOpen(true)}
              aria-label="Поддержка"
              className="flex size-8 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <LifeBuoy className="size-[18px]" />
            </button>
          }
        />
        <TooltipContent side="bottom">Поддержка</TooltipContent>
      </Tooltip>

      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="flex max-h-[88vh] w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
          onPaste={onPaste}
        >
          <DialogHeader className="gap-1.5 border-b border-border p-5">
            <DialogTitle className="flex items-center gap-2 text-base">
              <LifeBuoy className="size-[18px] text-primary" />
              Поддержка
            </DialogTitle>
            <DialogDescription>
              Сообщите об ошибке или предложите улучшение — с файлами и
              скриншотами. Обращение уйдёт команде разработки.
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            {/* Kind toggle */}
            <div className="grid grid-cols-2 gap-2">
              <KindOption
                active={kind === 'problem'}
                onClick={() => setKind('problem')}
                icon={<Bug className="size-4" />}
                label="Проблема"
                hint="Что-то работает не так"
              />
              <KindOption
                active={kind === 'suggestion'}
                onClick={() => setKind('suggestion')}
                icon={<Lightbulb className="size-4" />}
                label="Предложение"
                hint="Идея по улучшению"
              />
            </div>

            {/* Description */}
            <div className="flex flex-col gap-1.5">
              <label
                htmlFor="support-description"
                className="text-xs font-medium text-muted-foreground"
              >
                Описание
              </label>
              <Textarea
                id="support-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={
                  kind === 'problem'
                    ? 'Что произошло? Где и когда? Что вы делали в этот момент?'
                    : 'Что и как можно улучшить? Опишите вашу идею.'
                }
                className="min-h-28 resize-none"
                maxLength={4000}
              />
            </div>

            {/* Dropzone */}
            <div
              onDrop={onDrop}
              onDragOver={(e) => e.preventDefault()}
              onDragEnter={onDragEnter}
              onDragLeave={onDragLeave}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  inputRef.current?.click()
                }
              }}
              className={cn(
                'flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed px-4 py-6 text-center transition-colors',
                dragActive
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-primary/50 hover:bg-secondary/50',
              )}
            >
              <Upload
                className={cn(
                  'size-5 transition-colors',
                  dragActive ? 'text-primary' : 'text-muted-foreground',
                )}
              />
              <p className="text-sm font-medium">
                Перетащите файлы сюда или нажмите
              </p>
              <p className="text-xs text-muted-foreground">
                Скриншоты, видео и другие файлы. Также можно вставить из буфера
                (Ctrl/Cmd + V).
              </p>
              <input
                ref={inputRef}
                type="file"
                multiple
                hidden
                onChange={onInputChange}
              />
            </div>

            {/* Previews */}
            {attachments.length > 0 ? (
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>
                    Вложений: {attachments.length} · {humanSize(totalSize)}
                  </span>
                  <button
                    type="button"
                    onClick={resetForm}
                    className="font-medium text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    Очистить всё
                  </button>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                  {attachments.map((a) => (
                    <AttachmentTile
                      key={a.id}
                      attachment={a}
                      onRemove={() => removeAttachment(a.id)}
                    />
                  ))}
                </div>
              </div>
            ) : null}
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border bg-muted/40 p-4">
            <Button
              type="button"
              variant="ghost"
              onClick={() => handleOpenChange(false)}
              disabled={submitting}
            >
              Отмена
            </Button>
            <Button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting || description.trim().length < 3}
            >
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Отправка…
                </>
              ) : (
                'Отправить'
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

function KindOption({
  active,
  onClick,
  icon,
  label,
  hint,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  label: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'flex flex-col items-start gap-1 rounded-xl border p-3 text-left transition-colors',
        active
          ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
          : 'border-border hover:border-primary/40 hover:bg-secondary/50',
      )}
    >
      <span
        className={cn(
          'flex items-center gap-2 text-sm font-medium',
          active ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        <span className={active ? 'text-primary' : ''}>{icon}</span>
        {label}
      </span>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}

function AttachmentTile({
  attachment,
  onRemove,
}: {
  attachment: Attachment
  onRemove: () => void
}) {
  const { file, previewUrl } = attachment
  const isImage = file.type.startsWith('image/')
  const isVideo = file.type.startsWith('video/')

  return (
    <div className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-secondary/50">
      {isImage && previewUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={previewUrl || '/placeholder.svg'}
          alt={file.name}
          className="size-full object-cover"
        />
      ) : isVideo && previewUrl ? (
        <video
          src={previewUrl}
          className="size-full object-cover"
          muted
          playsInline
        />
      ) : (
        <div className="flex size-full flex-col items-center justify-center gap-1 p-2 text-center">
          {file.type ? (
            <FileText className="size-6 text-muted-foreground" />
          ) : (
            <Paperclip className="size-6 text-muted-foreground" />
          )}
          <span className="line-clamp-2 break-all text-[10px] leading-tight text-muted-foreground">
            {file.name}
          </span>
        </div>
      )}

      {/* Filename + size overlay for media */}
      {previewUrl ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-1">
          <p className="truncate text-[10px] text-white">
            {humanSize(file.size)}
          </p>
        </div>
      ) : null}

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation()
          onRemove()
        }}
        aria-label={`Удалить ${file.name}`}
        className="absolute right-1 top-1 flex size-5 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity hover:bg-black/80 group-hover:opacity-100"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
