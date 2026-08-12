'use client'

import { useRef } from 'react'
import { MessageSquare, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { downscaleImage, Field, HEX_RE, type TabProps } from './shared'

export function AppearanceTab({ config, patch }: TabProps) {
  const a = config.appearance
  const color = HEX_RE.test(a.color) ? a.color : '#2563eb'
  const avatarInputRef = useRef<HTMLInputElement>(null)

  // Read an uploaded image, downscale it to a small square via <canvas>, and
  // store the result as a data URL directly in the config. This keeps avatars
  // self-contained (no external hosting / blob storage needed) while bounding
  // the stored size so the JSON config stays small.
  async function onAvatarFile(file: File | undefined | null) {
    if (!file) return
    if (!file.type.startsWith('image/')) {
      toast.error('Загрузите изображение.')
      return
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('Файл слишком большой (макс. 5 МБ).')
      return
    }
    try {
      const dataUrl = await downscaleImage(file, 160)
      patch((d) => void (d.appearance.agentAvatar = dataUrl))
    } catch {
      toast.error('Не удалось обработать изображение.')
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Field label="Заголовок шапки">
        <Input
          value={a.title}
          onChange={(e) => patch((d) => void (d.appearance.title = e.target.value))}
          placeholder="Чат поддержки"
        />
      </Field>
      <Field label="Подзаголовок" hint="Короткая строка под заголовком.">
        <Input
          value={a.subtitle}
          onChange={(e) =>
            patch((d) => void (d.appearance.subtitle = e.target.value))
          }
          placeholder="Обычно отвечаем за 5 минут"
        />
      </Field>
      <Field label="Имя агента" hint="Показывается рядом с аватаром.">
        <Input
          value={a.agentName}
          onChange={(e) =>
            patch((d) => void (d.appearance.agentName = e.target.value))
          }
          placeholder="Анна"
        />
      </Field>
      <Field label="Аватар агента" hint="Загрузите картинку. Пусто — иконка.">
        <div className="flex items-center gap-3">
          <div className="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-muted">
            {a.agentAvatar ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={a.agentAvatar || '/placeholder.svg'}
                alt="Аватар агента"
                className="size-full object-cover"
                loading="lazy"
                decoding="async"
              />
            ) : (
              <MessageSquare className="size-5 text-muted-foreground" />
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              void onAvatarFile(e.target.files?.[0])
              e.target.value = ''
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => avatarInputRef.current?.click()}
          >
            <Upload className="size-4" />
            {a.agentAvatar ? 'Заменить' : 'Загрузить'}
          </Button>
          {a.agentAvatar ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() =>
                patch((d) => void (d.appearance.agentAvatar = ''))
              }
            >
              <X className="size-4" />
              Удалить
            </Button>
          ) : null}
        </div>
      </Field>
      <Field label="Фирменный цвет">
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={color}
            onChange={(e) =>
              patch((d) => void (d.appearance.color = e.target.value))
            }
            className="h-9 w-12 shrink-0 cursor-pointer rounded-md border border-border bg-background p-1"
            aria-label="Выбор фирменного цвета"
          />
          <Input
            value={a.color}
            onChange={(e) =>
              patch((d) => void (d.appearance.color = e.target.value))
            }
            placeholder="#2563eb"
            className="font-mono"
          />
        </div>
      </Field>
      <Field label="Сторона на странице">
        <Select
          value={a.position}
          onValueChange={(v) =>
            patch((d) => void (d.appearance.position = v === 'left' ? 'left' : 'right'))
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="right">Справа</SelectItem>
            <SelectItem value="left">Слева</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="rounded-lg border border-border p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          Приветственное облачко над кнопкой
        </p>
        <div className="flex flex-col gap-3">
          <Field label="Текст облачка" hint="Пусто — облачко не показывается.">
            <Input
              value={a.greeting}
              onChange={(e) =>
                patch((d) => void (d.appearance.greeting = e.target.value))
              }
              placeholder="Здравствуйте! Чем помочь?"
            />
          </Field>
          <Field label="Вторая строка облачка">
            <Input
              value={a.greetingSub}
              onChange={(e) =>
                patch((d) => void (d.appearance.greetingSub = e.target.value))
              }
              placeholder="Нажмите, чтобы начать"
            />
          </Field>
        </div>
      </div>
    </div>
  )
}
