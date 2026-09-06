'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Loader2, UploadCloud, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { compressImageFile } from '@/lib/compress-image'
import { MAX_BATCH_FILES } from '@/lib/media-batch'

// Telegram-style multi-file staging shared by every composer (manager, curator,
// god messenger). Files are collected into a tray, optionally captioned, then
// sent as a batch — the first file of the batch carries the caption. Object URLs
// for image thumbnails are created lazily and revoked on removal/unmount so the
// tray never leaks memory.

/**
 * Bulk photo upload: a dialog routinely needs 50–100+ pictures at once, so the
 * tray takes a whole gallery selection in one go instead of ten at a time.
 */
export const MAX_STAGED_FILES = MAX_BATCH_FILES

/**
 * Photos are compressed on the client before staging. Running 100 canvas
 * decodes at once would spike memory on a phone, so compression is throttled
 * to a few files in flight; the rest queue up and appear as they finish.
 */
const COMPRESS_CONCURRENCY = 3

/** How many thumbnails the tray renders before collapsing into a "+N" tile. */
const TRAY_VISIBLE_THUMBS = 24

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

export type StagedFile = {
  id: string
  file: File
  previewUrl: string | null
}

export type MediaStaging = ReturnType<typeof useMediaStaging>

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function dragCarriesFiles(e: React.DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  // DataTransfer.types is a DOMStringList in some engines — normalise.
  return Array.from(types as ArrayLike<string>).includes('Files')
}

export function useMediaStaging() {
  const [files, setFiles] = useState<StagedFile[]>([])
  const [dragActive, setDragActive] = useState(false)
  // Files picked but still being compressed — drives the "preparing N" hint so
  // a 100-photo selection does not look like nothing happened.
  const [preparing, setPreparing] = useState(0)
  // Nested elements fire dragenter/dragleave as the pointer crosses children;
  // a depth counter keeps the overlay stable until the pointer truly leaves.
  const dragDepth = useRef(0)
  // Mirror for unmount cleanup without adding files to the effect deps.
  const filesRef = useRef<StagedFile[]>([])
  useEffect(() => {
    filesRef.current = files
  }, [files])
  // Реальное число занятых слотов = уже готовые + ещё сжимающиеся: без этого
  // два быстрых выбора подряд могли переполнить трей, пока шло сжатие первого.
  const reservedRef = useRef(0)

  const addFiles = useCallback(async (incoming: FileList | File[]) => {
    const room = MAX_STAGED_FILES - filesRef.current.length - reservedRef.current
    if (room <= 0) return
    const picked = Array.from(incoming).slice(0, room)
    if (picked.length === 0) return
    reservedRef.current += picked.length
    setPreparing((n) => n + picked.length)

    // Сжимаем фото ПЕРЕД постановкой в очередь: даунскейл до 2048px + JPEG
    // превращает 8–12 МБ снимок с камеры в ~0.5–1.5 МБ, поэтому и отправка, и
    // само превью грузятся в разы быстрее. compressImageFile безопасен —
    // не-изображения, GIF/SVG и мелкие файлы возвращаются как есть, а любая
    // ошибка декодирования отдаёт оригинал. Общий чокпоинт: подхватывают все
    // композеры (менеджер, куратор), использующие useMediaStaging.
    //
    // Каждый готовый файл попадает в трей СРАЗУ (а не всей пачкой в конце),
    // и в исходном порядке выбора — очередь по индексу сохраняет порядок,
    // даже если файлы досжимаются не по очереди.
    const ready: (StagedFile | null)[] = picked.map(() => null)
    let flushed = 0
    const flush = () => {
      const batch: StagedFile[] = []
      while (flushed < ready.length && ready[flushed]) {
        batch.push(ready[flushed] as StagedFile)
        flushed++
      }
      if (batch.length === 0) return
      reservedRef.current -= batch.length
      setPreparing((n) => Math.max(0, n - batch.length))
      setFiles((prev) => [...prev, ...batch].slice(0, MAX_STAGED_FILES))
    }
    try {
      await mapWithConcurrency(picked, COMPRESS_CONCURRENCY, async (file, i) => {
        const out = file.type.startsWith('image/')
          ? await compressImageFile(file)
          : file
        ready[i] = {
          id: makeId(),
          file: out,
          previewUrl: out.type.startsWith('image/')
            ? URL.createObjectURL(out)
            : null,
        }
        flush()
      })
    } finally {
      flush()
      // Anything still reserved here means compression threw for that slot.
      const leaked = ready.filter((r) => r === null).length
      if (leaked) {
        reservedRef.current -= leaked
        setPreparing((n) => Math.max(0, n - leaked))
      }
    }
  }, [])

  const removeFile = useCallback((id: string) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id)
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl)
      return prev.filter((f) => f.id !== id)
    })
  }, [])

  const clear = useCallback(() => {
    setFiles((prev) => {
      prev.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
      return []
    })
  }, [])

  useEffect(
    () => () => {
      filesRef.current.forEach((f) => {
        if (f.previewUrl) URL.revokeObjectURL(f.previewUrl)
      })
    },
    [],
  )

  // Spread onto the composer container to accept desktop drag-and-drop.
  const dragHandlers = {
    onDragEnter: (e: React.DragEvent) => {
      if (!dragCarriesFiles(e)) return
      e.preventDefault()
      dragDepth.current += 1
      setDragActive(true)
    },
    onDragOver: (e: React.DragEvent) => {
      if (!dragCarriesFiles(e)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    },
    onDragLeave: (e: React.DragEvent) => {
      if (!dragCarriesFiles(e)) return
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (dragDepth.current === 0) setDragActive(false)
    },
    onDrop: (e: React.DragEvent) => {
      if (!dragCarriesFiles(e)) return
      e.preventDefault()
      dragDepth.current = 0
      setDragActive(false)
      if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files)
    },
  }

  return {
    files,
    count: files.length,
    /** Files picked but still compressing (not yet in `files`). */
    preparing,
    isFull: files.length >= MAX_STAGED_FILES,
    dragActive,
    addFiles,
    removeFile,
    clear,
    dragHandlers,
  }
}

/** Broad accept list shared by every file input in the composers. */
export const MEDIA_ACCEPT =
  'image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip'

/** Upload progress of the staged batch, rendered by the tray while sending. */
export type StagedSendProgress = { sent: number; total: number }

export function MediaTray({
  files,
  preparing = 0,
  onRemove,
  onClear,
  disabled,
  progress = null,
}: {
  files: StagedFile[]
  /** Files still being compressed — shown as a spinner tile with a count. */
  preparing?: number
  onRemove: (id: string) => void
  /** Drop the whole selection at once (a 100-photo tray is not cleared one by one). */
  onClear?: () => void
  disabled?: boolean
  /** While set, the tray shows a progress bar instead of the remove buttons. */
  progress?: StagedSendProgress | null
}) {
  if (files.length === 0 && preparing === 0) return null
  const visible = files.slice(0, TRAY_VISIBLE_THUMBS)
  const hidden = files.length - visible.length
  const total = files.length + preparing
  return (
    <div className="border-b border-border/60">
      <div className="flex items-center gap-2 px-3 pt-2 text-xs text-muted-foreground">
        <span className="tabular-nums">
          {progress
            ? `Отправка ${progress.sent} из ${progress.total}…`
            : preparing > 0
              ? `Подготовка ${files.length} из ${total}…`
              : `${files.length} ${plural(files.length, 'файл', 'файла', 'файлов')}`}
        </span>
        {onClear && !progress ? (
          <button
            type="button"
            disabled={disabled}
            onClick={onClear}
            className="ml-auto rounded px-1.5 py-0.5 font-medium transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
          >
            Очистить
          </button>
        ) : null}
      </div>
      {progress ? (
        <div
          className="mx-3 mt-1.5 h-1 overflow-hidden rounded-full bg-muted"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.sent}
          aria-label="Отправка файлов"
        >
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-300"
            style={{
              width: `${progress.total ? Math.round((progress.sent / progress.total) * 100) : 0}%`,
            }}
          />
        </div>
      ) : null}
      <div className="scrollbar-thin flex items-end gap-2 overflow-x-auto px-3 py-2">
        {visible.map((f) => (
          <div
            key={f.id}
            className="group relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted"
          >
            {f.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={f.previewUrl || '/placeholder.svg'}
                alt={f.file.name}
                loading="lazy"
                decoding="async"
                className="size-full object-cover"
              />
            ) : (
              <div className="flex size-full flex-col items-center justify-center gap-1 p-1 text-center">
                <FileText className="size-5 text-muted-foreground" />
                <span className="line-clamp-2 text-[9px] leading-tight text-muted-foreground">
                  {f.file.name}
                </span>
              </div>
            )}
            {!progress ? (
              <button
                type="button"
                disabled={disabled}
                onClick={() => onRemove(f.id)}
                className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow transition-opacity hover:bg-background focus:opacity-100 group-hover:opacity-100"
                aria-label={`Убрать ${f.file.name}`}
              >
                <X className="size-3" />
              </button>
            ) : null}
          </div>
        ))}
        {hidden > 0 ? (
          <div
            className="flex size-16 shrink-0 items-center justify-center rounded-lg border border-dashed border-border bg-muted/60 text-sm font-semibold tabular-nums text-muted-foreground"
            aria-label={`Ещё ${hidden} файлов`}
          >
            +{hidden}
          </div>
        ) : null}
        {preparing > 0 ? (
          <div
            className="flex size-16 shrink-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-muted/60 text-[10px] tabular-nums text-muted-foreground"
            role="status"
            aria-label={`Подготовка ${preparing} файлов`}
          >
            <Loader2 className="size-4 animate-spin" />
            {preparing}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

export function DropOverlay({ active }: { active: boolean }) {
  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-lg border-2 border-dashed border-primary bg-primary/10 backdrop-blur-sm transition-opacity',
        active ? 'opacity-100' : 'opacity-0',
      )}
      aria-hidden={!active}
    >
      <div className="flex flex-col items-center gap-2 text-primary">
        <UploadCloud className="size-7" />
        <span className="text-sm font-medium">Отпустите файлы, чтобы прикрепить</span>
      </div>
    </div>
  )
}
