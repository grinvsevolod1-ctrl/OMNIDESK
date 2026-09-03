'use client'

import { useState, useTransition } from 'react'
import { Loader2, Send } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { startCuratorTelegramOutreachAction } from '@/app/actions/curator-outreach'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

/**
 * Диалог «Написать в Telegram» для куратора — точное зеркало менеджерского
 * (см. components/manager/inbox/new-telegram-chat.tsx), но вызывает
 * curator-scoped экшен: сообщение уходит с рабочего аккаунта для исходящих, а
 * созданный диалог сразу привязан к куратору и появляется в его «Чатах».
 */
function CuratorTelegramComposeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated?: (conversationId: string) => void
}) {
  const router = useRouter()
  const [username, setUsername] = useState('')
  const [name, setName] = useState('')
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()

  const handle = username.trim().replace(/^@+/, '')
  const canSend = Boolean(handle && text.trim())

  function send() {
    if (!canSend || pending) return
    startTransition(async () => {
      const res = await startCuratorTelegramOutreachAction({
        username: handle || undefined,
        contactName: name.trim() || undefined,
        message: text.trim(),
      })
      if (res.ok) {
        toast.success(res.message)
        onOpenChange(false)
        setText('')
        if (res.conversationId) onCreated?.(res.conversationId)
        router.refresh()
      } else {
        toast.error(res.message)
        if (res.conversationId) onCreated?.(res.conversationId)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={(v) => !pending && onOpenChange(v)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Написать в Telegram</DialogTitle>
          <DialogDescription>
            Сообщение уйдёт с рабочего аккаунта для исходящих. Диалог появится
            в вашем разделе «Чаты».
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="curator-tg-username">Ник в Telegram</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                @
              </span>
              <Input
                id="curator-tg-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                autoFocus
                disabled={pending}
                className="pl-8 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Ник, который контакт оставил вам (например, в VK) — с @ или без.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="curator-tg-name">
              Имя контакта{' '}
              <span className="font-normal text-muted-foreground">
                (необязательно)
              </span>
            </Label>
            <Input
              id="curator-tg-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Как подписать диалог в списке чатов"
              disabled={pending}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="curator-tg-text">Сообщение</Label>
            <Textarea
              id="curator-tg-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={4}
              placeholder="Здравствуйте! Пишу по вашей заявке…"
              disabled={pending}
              onKeyDown={(e) => {
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
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Отмена
          </Button>
          <Button onClick={send} disabled={pending || !canSend}>
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
  )
}

/**
 * Кнопка «Написать в ТГ» в шапке списка чатов куратора. Точка входа, когда
 * контакт оставил ник в другом канале и нужно выйти на него в Telegram с
 * рабочего аккаунта. Рендерится только если аккаунт для исходящих доступен
 * (родитель прокидывает `available`).
 */
export function CuratorOutreachButton({
  available,
  onOpenConversation,
}: {
  available: boolean
  onOpenConversation?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  if (!available) return null
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
        title="Написать в Telegram с рабочего аккаунта (по нику из другого канала)"
      >
        <Send className="size-3" />
        Написать в ТГ
      </button>
      {open ? (
        <CuratorTelegramComposeDialog
          open={open}
          onOpenChange={setOpen}
          onCreated={onOpenConversation}
        />
      ) : null}
    </>
  )
}
