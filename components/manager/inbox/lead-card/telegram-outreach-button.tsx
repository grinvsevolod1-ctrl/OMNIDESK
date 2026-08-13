'use client'

import { useState, useTransition } from 'react'
import { Loader2, Send } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { startTelegramOutreachAction } from '@/app/actions/telegram-outreach'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'

/**
 * Маленькая кнопка «написать лиду в Telegram» рядом с полем Telegram в
 * карточке лида. Менеджер пишет ПЕРВЫМ — строго с рабочего аккаунта,
 * назначенного админом (не с личного). Сценарий: лид пришёл из VK со своего
 * личного аккаунта и не хочет продолжать там. Созданный диалог появляется в
 * инбоксе менеджера как обычный Telegram-тред.
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
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()

  const handle = username.trim().replace(/^@+/, '')
  const id = telegramId.trim()
  // Без адресата кнопке нечего делать — не показываем вовсе.
  if (!handle && !/^\d+$/.test(id)) return null

  const targetLabel = handle ? `@${handle}` : `id ${id}`

  function send() {
    const body = text.trim()
    if (!body) {
      toast.error('Напишите текст сообщения.')
      return
    }
    startTransition(async () => {
      const res = await startTelegramOutreachAction({
        username: handle || undefined,
        telegramId: /^\d+$/.test(id) ? id : undefined,
        contactName,
        message: body,
      })
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setText('')
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

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

      <Dialog open={open} onOpenChange={(v) => !pending && setOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Написать в Telegram</DialogTitle>
            <DialogDescription>
              Сообщение для {targetLabel} уйдёт с рабочего аккаунта для
              исходящих (не с вашего личного). Диалог появится в вашем инбоксе.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={4}
            autoFocus
            placeholder="Здравствуйте! Пишу по вашей заявке…"
            disabled={pending}
            onKeyDown={(e) => {
              // Ctrl/Cmd+Enter — отправить; учитываем CJK-композицию.
              if (
                e.key === 'Enter' &&
                (e.ctrlKey || e.metaKey) &&
                !e.nativeEvent.isComposing &&
                e.keyCode !== 229
              ) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={pending}
            >
              Отмена
            </Button>
            <Button onClick={send} disabled={pending || !text.trim()}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Отправить
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
