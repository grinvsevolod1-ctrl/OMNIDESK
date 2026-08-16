'use client'

import { useState } from 'react'
import { Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { TelegramComposeDialog } from '../new-telegram-chat'

/**
 * Маленькая кнопка «написать лиду в Telegram» рядом с полем Telegram в
 * карточке лида. Открывает общий диалог аутрича (см. new-telegram-chat.tsx)
 * с предзаполненным ником из карточки — отправка строго с рабочего аккаунта
 * для исходящих, назначенного админом.
 */
export function TelegramOutreachButton({
  username,
  telegramId,
  contactName,
}: {
  /** @username из карточки (может быть пустым). */
  username: string
  /** Числовой Telegram ID из карточки (может быть пустым). */
  telegramId: string
  contactName?: string
}) {
  const [open, setOpen] = useState(false)

  const handle = username.trim().replace(/^@+/, '')
  const id = telegramId.trim()
  // Без адресата кнопке нечего делать — не показываем вовсе.
  if (!handle && !/^\d+$/.test(id)) return null

  const targetLabel = handle ? `@${handle}` : `id ${id}`

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        onClick={() => setOpen(true)}
        title={`Написать ${targetLabel} в Telegram с рабочего аккаунта`}
        aria-label="Написать лиду в Telegram с рабочего аккаунта"
        className="shrink-0"
      >
        <Send className="size-3.5" />
      </Button>
      {/* Монтируем по требованию: initial-значения подхватываются свежими
          при каждом открытии, черновик прошлого раза не всплывает. */}
      {open ? (
        <TelegramComposeDialog
          open={open}
          onOpenChange={setOpen}
          initialUsername={handle}
          initialName={contactName ?? ''}
          telegramId={/^\d+$/.test(id) ? id : undefined}
        />
      ) : null}
    </>
  )
}
