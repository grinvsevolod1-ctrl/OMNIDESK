'use client'

/**
 * Управление собственной аватаркой в настройках. Клик по аватарке (или по
 * кнопке) открывает диалог выбора: 20 готовых образов (мультяшные зверята) либо
 * загрузка своего фото. Само сохранение — общий AvatarPickerDialog; сюда лишь
 * прокидываем нужное серверное действие (по умолчанию — для ролей из managers,
 * но админ передаёт своё через проп `action`).
 */

import { useState } from 'react'
import { Camera } from 'lucide-react'
import { updateMyAvatarAction } from '@/app/actions/account'
import type { SimpleResult } from '@/app/actions/account-shared'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { Button } from '@/components/ui/button'
import { AvatarPickerDialog } from '@/components/shared/avatar-picker'

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function AvatarUploader({
  name,
  initialAvatarUrl,
  action = updateMyAvatarAction,
}: {
  name: string
  initialAvatarUrl: string | null
  /** Серверное сохранение аватарки. Админ передаёт updateAdminAvatarAction. */
  action?: (value: string | null) => Promise<SimpleResult>
}) {
  const [avatar, setAvatar] = useState<string | null>(initialAvatarUrl)
  const [open, setOpen] = useState(false)

  return (
    <div className="flex items-center gap-4">
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group relative rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-card"
        aria-label="Изменить аватар"
      >
        <Avatar className="size-20 ring-2 ring-border ring-offset-2 ring-offset-card">
          {avatar ? <AvatarImage src={avatar} alt={name} /> : null}
          <AvatarFallback className="bg-secondary text-lg font-semibold text-secondary-foreground">
            {initials(name)}
          </AvatarFallback>
        </Avatar>
        <span className="absolute inset-0 flex items-center justify-center rounded-full bg-background/60 opacity-0 transition-opacity group-hover:opacity-100">
          <Camera className="size-5 text-foreground" />
        </span>
      </button>

      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setOpen(true)}
        >
          <Camera className="size-4" />
          {avatar ? 'Изменить аватар' : 'Выбрать аватар'}
        </Button>
        <p className="text-xs text-muted-foreground">
          20 готовых образов или своё фото (PNG, JPEG, WebP). Хранится локально,
          без внешних сервисов.
        </p>
      </div>

      <AvatarPickerDialog
        open={open}
        onOpenChange={setOpen}
        currentAvatar={avatar}
        action={action}
        onSaved={setAvatar}
      />
    </div>
  )
}
