'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, UploadCloud, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { compressImageFile } from '@/lib/compress-image'

// Telegram-style multi-file staging shared by every composer (manager, curator,
// god messenger). Files are collected into a tray, optionally captioned, then
// sent as a batch — the first file of the batch carries the caption. Object URLs
// for image thumbnails are created lazily and revoked on removal/unmount so the
// tray never leaks memory.

export const MAX_STAGED_FILES = 10

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
  // Nested elements fire dragenter/dragleave as the pointer crosses children;
  // a depth counter keeps the overlay stable until the pointer truly leaves.
  const dragDepth = useRef(0)
  // Mirror for unmount cleanup without adding files to the effect deps.
  const filesRef = useRef<StagedFile[]>([])
  useEffect(() => {
    filesRef.current = files
  }, [files])

  const addFiles = useCallback(async (incoming: FileList | File[]) => {
    const room = MAX_STAGED_FILES - filesRef.current.length
    if (room <= 0) return
    const picked = Array.from(incoming).slice(0, room)
    if (picked.length === 0) return

    // Сжимаем фото ПЕРЕД постановкой в очередь: даунскейл до 2048px + JPEG
    // превращает 8–12 МБ снимок с камеры в ~0.5–1.5 МБ, поэтому и отправка, и
    // само превью грузятся в разы быстрее. compressImageFile безопасен —
    // не-изображения, GIF/SVG и мелкие файлы возвращаются как есть, а любая
    // ошибка декодирования отдаёт оригинал. Общий чокпоинт: подхватывают все
    // композеры (менеджер, куратор), использующие useMediaStaging.
    const prepared = await Promise.all(
      picked.map(async (file) => {
        const out = file.type.startsWith('image/')
          ? await compressImageFile(file)
          : file
        return {
          id: makeId(),
          file: out,
          previewUrl: out.type.startsWith('image/')
            ? URL.createObjectURL(out)
            : null,
        }
      }),
    )

    setFiles((prev) => {
      // Повторный кламп: пока шло асинхронное сжатие, очередь могла пополниться.
      const stillRoom = MAX_STAGED_FILES - prev.length
      if (stillRoom <= 0) {
        prepared.forEach((p) => {
          if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
        })
        return prev
      }
      const accepted = prepared.slice(0, stillRoom)
      prepared.slice(stillRoom).forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl)
      })
      return [...prev, ...accepted]
    })
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

export function MediaTray({
  files,
  onRemove,
  disabled,
}: {
  files: StagedFile[]
  onRemove: (id: string) => void
  disabled?: boolean
}) {
  if (files.length === 0) return null
  return (
    <div className="scrollbar-thin flex items-end gap-2 overflow-x-auto border-b border-border/60 px-3 py-2">
      {files.map((f) => (
        <div
          key={f.id}
          className="group relative size-16 shrink-0 overflow-hidden rounded-lg border border-border bg-muted"
        >
          {f.previewUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={f.previewUrl || '/placeholder.svg'}
              alt={f.file.name}
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
          <button
            type="button"
            disabled={disabled}
            onClick={() => onRemove(f.id)}
            className="absolute right-0.5 top-0.5 flex size-5 items-center justify-center rounded-full bg-background/80 text-foreground opacity-0 shadow transition-opacity hover:bg-background focus:opacity-100 group-hover:opacity-100"
            aria-label={`Убрать ${f.file.name}`}
          >
            <X className="size-3" />
          </button>
        </div>
      ))}
    </div>
  )
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
