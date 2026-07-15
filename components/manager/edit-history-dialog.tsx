'use client'

import useSWR from 'swr'
import { History, Loader2 } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { MessageEdit } from '@/lib/types'

/** Human label for a media kind shown when a version had an attachment. */
function mediaKindLabel(kind?: string): string {
  switch (kind) {
    case 'photo':
      return 'Фото'
    case 'video':
      return 'Видео'
    case 'voice':
      return 'Голосовое'
    case 'audio':
      return 'Аудио'
    case 'document':
      return 'Документ'
    case 'sticker':
      return 'Стикер'
    default:
      return 'Вложение'
  }
}

function fmt(ts: string): string {
  try {
    return new Date(ts).toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  } catch {
    return ts
  }
}

const fetcher = (url: string) =>
  fetch(url).then((r) => {
    if (!r.ok) throw new Error(String(r.status))
    return r.json() as Promise<{ edits: MessageEdit[] }>
  })

interface EditHistoryDialogProps {
  /** Message id to load history for; null closes the dialog. */
  messageId: string | null
  /** The CURRENT (latest) body, shown as the final version in the timeline. */
  currentBody: string
  /** Current media kind, if the live message still carries media. */
  currentMediaType?: string
  /** Panel URL for the current media, if any. */
  currentMediaUrl?: string
  onOpenChange: (open: boolean) => void
}

/**
 * Shows the full before/after trail of an edited message: every prior version
 * (oldest first) plus the current one at the bottom, each with its own media if
 * it had any. Data is fetched on open from the edits API.
 */
export function EditHistoryDialog({
  messageId,
  currentBody,
  currentMediaType,
  currentMediaUrl,
  onOpenChange,
}: EditHistoryDialogProps) {
  const { data, isLoading, error } = useSWR(
    messageId ? `/api/messages/${messageId}/edits` : null,
    fetcher,
  )
  const edits = data?.edits ?? []

  return (
    <Dialog open={Boolean(messageId)} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="size-4" />
            История изменений
          </DialogTitle>
          <DialogDescription>
            Все версии сообщения — от исходной до текущей. Старый текст и медиа
            сохранены даже после правки.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
          {isLoading ? (
            <div className="flex items-center justify-center py-6 text-muted-foreground">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : error ? (
            <p className="py-4 text-center text-sm text-destructive">
              Не удалось загрузить историю.
            </p>
          ) : (
            <>
              {edits.map((e, i) => (
                <EditVersion
                  key={e.id}
                  label={i === 0 ? 'Исходное' : `Версия ${e.version}`}
                  body={e.body}
                  mediaType={e.mediaType}
                  mediaUrl={e.mediaUrl}
                  recordedAt={e.recordedAt}
                  superseded
                />
              ))}
              <EditVersion
                label="Текущая версия"
                body={currentBody}
                mediaType={currentMediaType}
                mediaUrl={currentMediaUrl}
              />
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function EditVersion({
  label,
  body,
  mediaType,
  mediaUrl,
  recordedAt,
  superseded,
}: {
  label: string
  body: string
  mediaType?: string
  mediaUrl?: string
  recordedAt?: string
  superseded?: boolean
}) {
  const isImage = mediaType === 'photo' || mediaType === 'sticker'
  return (
    <div
      className={cnLocal(
        'rounded-lg border p-3',
        superseded
          ? 'border-border bg-muted/40'
          : 'border-primary/30 bg-primary/5',
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className={cnLocal(
            'text-xs font-semibold',
            superseded ? 'text-muted-foreground' : 'text-primary',
          )}
        >
          {label}
        </span>
        {recordedAt ? (
          <span className="text-[10px] text-muted-foreground">
            изменено {fmt(recordedAt)}
          </span>
        ) : null}
      </div>

      {mediaType ? (
        isImage && mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl || '/placeholder.svg'}
            alt={mediaKindLabel(mediaType)}
            className="mb-1.5 max-h-40 rounded-md object-contain"
          />
        ) : (
          <a
            href={mediaUrl}
            target="_blank"
            rel="noopener noreferrer"
            className={cnLocal(
              'mb-1.5 inline-block text-xs underline',
              mediaUrl
                ? 'text-primary'
                : 'pointer-events-none text-muted-foreground',
            )}
          >
            {mediaKindLabel(mediaType)}
            {mediaUrl ? '' : ' (недоступно)'}
          </a>
        )
      ) : null}

      {body ? (
        <p className="whitespace-pre-wrap break-words text-sm leading-relaxed [overflow-wrap:anywhere]">
          {body}
        </p>
      ) : mediaType ? null : (
        <p className="text-xs italic text-muted-foreground">Пустое сообщение</p>
      )}
    </div>
  )
}

/** Local class combiner to avoid a cross-import for one helper. */
function cnLocal(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(' ')
}
