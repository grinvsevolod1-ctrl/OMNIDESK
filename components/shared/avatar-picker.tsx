'use client'

/**
 * Диалог выбора аватарки: сетка из 20 готовых образов (дружелюбные мультяшные
 * зверята) + загрузка собственного фото + сброс. Общий для всех ролей —
 * конкретное сохранение приходит пропом `action` (менеджер/куратор/
 * руководитель/байер → своя строка в managers; админ → app_settings).
 * Загруженное фото сжимается на клиенте в квадрат 256×256 (JPEG data:-URL),
 * готовый образ уходит коротким путём /avatars/avatar-XX.webp. Никаких
 * сторонних хранилищ.
 */

import { useRef, useState, useTransition } from 'react'
import Image from 'next/image'
import { Camera, Check, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { AVATAR_PRESETS } from '@/lib/avatar-presets'
import type { SimpleResult } from '@/app/actions/account-shared'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/** Сторона квадрата аватарки (retina-friendly, но лёгкая). */
const AVATAR_SIZE = 256
const JPEG_QUALITY = 0.85
const MAX_SOURCE_BYTES = 10 * 1024 * 1024

/** Файл → квадратный сжатый data:-URL прямо в браузере. */
async function fileToSquareDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      // document.createElement, а не `new Image()`, — в модуле импортирован
      // next/image как `Image`, и конструктор бы конфликтовал с ним.
      const el = document.createElement('img')
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Не удалось прочитать изображение'))
      el.src = objectUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas недоступен')
    const side = Math.min(img.width, img.height)
    const sx = (img.width - side) / 2
    const sy = (img.height - side) / 2
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function AvatarPickerDialog({
  open,
  onOpenChange,
  currentAvatar,
  action,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  currentAvatar: string | null
  /** Серверное сохранение аватарки (готовый путь, data:-URL или null-сброс). */
  action: (value: string | null) => Promise<SimpleResult>
  /** Колбэк с новым значением после успешного сохранения (для optimistic UI). */
  onSaved: (value: string | null) => void
}) {
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement | null>(null)

  function save(value: string | null) {
    startTransition(async () => {
      const res = await action(value)
      if (res.ok) {
        onSaved(value)
        toast.success(res.message)
        onOpenChange(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  function handleFile(file: File) {
    if (!file.type.startsWith('image/')) {
      toast.error('Выберите файл изображения.')
      return
    }
    if (file.size > MAX_SOURCE_BYTES) {
      toast.error('Файл слишком большой (максимум 10 МБ).')
      return
    }
    startTransition(async () => {
      let dataUrl: string
      try {
        dataUrl = await fileToSquareDataUrl(file)
      } catch (err) {
        console.error('[v0] avatar processing failed:', err)
        toast.error('Не удалось обработать изображение.')
        return
      }
      const res = await action(dataUrl)
      if (res.ok) {
        onSaved(dataUrl)
        toast.success(res.message)
        onOpenChange(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Выбор аватара</DialogTitle>
          <DialogDescription>
            Выберите один из образов или загрузите своё фото.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-5 gap-2">
          {AVATAR_PRESETS.map((src, i) => {
            const selected = currentAvatar === src
            return (
              <button
                key={src}
                type="button"
                disabled={pending}
                onClick={() => save(src)}
                aria-label={`Образ ${i + 1}`}
                aria-pressed={selected}
                className={cn(
                  'relative aspect-square overflow-hidden rounded-lg ring-2 transition',
                  'focus:outline-none focus-visible:ring-ring',
                  selected
                    ? 'ring-primary'
                    : 'ring-transparent hover:ring-border',
                )}
              >
                <Image
                  src={src || '/placeholder.svg'}
                  alt={`Образ ${i + 1}`}
                  fill
                  sizes="64px"
                  className="object-cover"
                />
                {selected ? (
                  <span className="absolute inset-0 flex items-center justify-center bg-primary/40">
                    <Check className="size-5 text-primary-foreground" />
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) handleFile(f)
            e.target.value = ''
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Camera className="size-4" />
            )}
            Загрузить своё
          </Button>
          {currentAvatar ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => save(null)}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
              Сбросить
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}
