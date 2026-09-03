'use client'

/**
 * Локальная загрузка аватарки (менеджер / куратор / руководитель). ПОЛНОСТЬЮ
 * без сторонних сервисов: выбранный файл рисуется на <canvas>, кадрируется в
 * квадрат по центру, ужимается до 256×256 и экспортируется в JPEG data:-URL,
 * который уходит в updateMyAvatarAction и хранится прямо в БД. Так итоговая
 * строка — десятки КБ, а не мегабайты исходника.
 */

import { useRef, useState, useTransition } from 'react'
import { Camera, Loader2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { updateMyAvatarAction } from '@/app/actions/account'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'

/** Сторона квадрата аватарки в пикселях (retina-friendly, но всё ещё лёгкая). */
const AVATAR_SIZE = 256
/** Качество JPEG при экспорте — баланс веса и чёткости. */
const JPEG_QUALITY = 0.85
/** Предел исходного файла ДО сжатия (защита от гигантских картинок). */
const MAX_SOURCE_BYTES = 10 * 1024 * 1024

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

/**
 * Прочитать файл в <img>, отрисовать по центру в квадратный canvas и вернуть
 * сжатый data:-URL. Всё в браузере — на сервер уходит уже готовая строка.
 */
async function fileToSquareDataUrl(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = () => reject(new Error('Не удалось прочитать изображение'))
      el.src = objectUrl
    })
    const canvas = document.createElement('canvas')
    canvas.width = AVATAR_SIZE
    canvas.height = AVATAR_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas недоступен')
    // Кадрирование по центру: берём наибольший вписанный квадрат исходника.
    const side = Math.min(img.width, img.height)
    const sx = (img.width - side) / 2
    const sy = (img.height - side) / 2
    ctx.drawImage(img, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE)
    return canvas.toDataURL('image/jpeg', JPEG_QUALITY)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export function AvatarUploader({
  name,
  initialAvatarUrl,
}: {
  name: string
  initialAvatarUrl: string | null
}) {
  const [avatar, setAvatar] = useState<string | null>(initialAvatarUrl)
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLInputElement | null>(null)

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
      const res = await updateMyAvatarAction(dataUrl)
      if (res.ok) {
        setAvatar(dataUrl)
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
    })
  }

  function handleRemove() {
    startTransition(async () => {
      const res = await updateMyAvatarAction(null)
      if (res.ok) {
        setAvatar(null)
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        <Avatar className="size-20 ring-2 ring-border ring-offset-2 ring-offset-card">
          {avatar ? <AvatarImage src={avatar} alt={name} /> : null}
          <AvatarFallback className="bg-secondary text-lg font-semibold text-secondary-foreground">
            {initials(name)}
          </AvatarFallback>
        </Avatar>
        {pending ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-full bg-background/60">
            <Loader2 className="size-5 animate-spin text-foreground" />
          </div>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
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
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => inputRef.current?.click()}
          >
            <Camera className="size-4" />
            {avatar ? 'Заменить фото' : 'Загрузить фото'}
          </Button>
          {avatar ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={handleRemove}
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="size-4" />
              Удалить
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          PNG, JPEG или WebP. Изображение обрежется до квадрата и сожмётся —
          хранится локально, без внешних сервисов.
        </p>
      </div>
    </div>
  )
}
