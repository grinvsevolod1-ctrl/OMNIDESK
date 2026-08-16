'use client'

import { useEffect, useState, useTransition } from 'react'
import { Loader2, MessageSquare, Send } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  findExistingTelegramConversationAction,
  startTelegramOutreachAction,
} from '@/app/actions/telegram-outreach'
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
 * Диалог «Написать в Telegram»: менеджер вводит ник, который лид оставил в
 * другом канале (например, в VK), и пишет ему ПЕРВЫМ — строго с рабочего
 * аккаунта для исходящих, назначенного админом. Созданный диалог появляется
 * в инбоксе менеджера и живёт как обычный Telegram-тред.
 *
 * Используется в двух местах: кнопка в шапке инбокса (ник вводится вручную)
 * и кнопка у поля Telegram в карточке лида (ник предзаполнен, но правится).
 */
export function TelegramComposeDialog({
  open,
  onOpenChange,
  initialUsername = '',
  initialName = '',
  telegramId,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Предзаполненный @username (из карточки лида); всегда редактируем. */
  initialUsername?: string
  /** Предзаполненное имя контакта (из карточки лида). */
  initialName?: string
  /** Числовой Telegram ID, если известен (из карточки лида). */
  telegramId?: string
  /** Открыть созданный/найденный диалог в инбоксе. */
  onCreated?: (conversationId: string) => void
}) {
  const router = useRouter()
  const [username, setUsername] = useState(initialUsername)
  const [name, setName] = useState(initialName)
  const [text, setText] = useState('')
  const [pending, startTransition] = useTransition()
  // Id уже существующего диалога с этим контактом (проверяем по мере ввода).
  const [existingId, setExistingId] = useState<string | null>(null)

  const handle = username.trim().replace(/^@+/, '')
  const id = (telegramId ?? '').trim()
  const hasTarget = Boolean(handle || /^\d+$/.test(id))
  const canSend = Boolean(hasTarget && text.trim())
  // Баннер «уже есть диалог» показываем через производное значение, а не
  // синхронным setExistingId(null) в эффекте (react-hooks/set-state-in-effect):
  // пустой ввод «прячет» найденный id без лишнего каскадного ре-рендера.
  const foundExistingId = hasTarget ? existingId : null

  // Проверяем «уже есть диалог?» по мере ввода ника (с debounce). Если да —
  // покажем баннер «Открыть диалог» вместо создания нового. Ответ применяем
  // только если ник/id не изменились за время запроса (защита от гонки).
  useEffect(() => {
    if (!open) return
    const uname = handle
    const numeric = /^\d+$/.test(id) ? id : ''
    if (!uname && !numeric) return
    let cancelled = false
    const t = setTimeout(async () => {
      const res = await findExistingTelegramConversationAction({
        username: uname || undefined,
        telegramId: numeric || undefined,
      }).catch(() => null)
      if (!cancelled) setExistingId(res?.conversationId ?? null)
    }, 400)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [open, handle, id])

  function openExisting() {
    if (!foundExistingId) return
    onOpenChange(false)
    onCreated?.(foundExistingId)
    router.refresh()
  }

  function send() {
    if (!canSend || pending) return
    startTransition(async () => {
      const res = await startTelegramOutreachAction({
        username: handle || undefined,
        telegramId: /^\d+$/.test(id) ? id : undefined,
        contactName: name.trim() || undefined,
        message: text.trim(),
      })
      if (res.ok) {
        // alreadyExists — открыли существующий тред, «отправлено» не пишем.
        toast.success(res.message)
        onOpenChange(false)
        setText('')
        if (res.conversationId) onCreated?.(res.conversationId)
        router.refresh()
      } else {
        toast.error(res.message)
        // Тред уже существует у ЭТОГО менеджера, а отправка не удалась —
        // всё равно откроем диалог, чтобы можно было продолжить оттуда.
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
            Сообщение уйдёт с рабочего аккаунта для исходящих (не с вашего
            личного). Диалог появится в вашем списке чатов.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tg-compose-username">Ник в Telegram</Label>
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                @
              </span>
              <Input
                id="tg-compose-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="username"
                autoFocus={!initialUsername}
                disabled={pending}
                className="pl-8 font-mono"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Ник, который лид оставил вам (например, в VK) — с @ или без.
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="tg-compose-name">
              Имя контакта{' '}
              <span className="font-normal text-muted-foreground">
                (необязательно)
              </span>
            </Label>
            <Input
              id="tg-compose-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Как подписать диалог в списке чатов"
              disabled={pending}
            />
          </div>

          {foundExistingId ? (
            /* С этим контактом уже есть диалог — не создаём новый, открываем. */
            <div className="flex items-start gap-2.5 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2.5 text-sm">
              <MessageSquare className="mt-0.5 size-4 shrink-0 text-primary" />
              <p className="text-pretty text-foreground">
                С этим контактом уже есть диалог. Откройте его, чтобы
                продолжить переписку, — новый создавать не нужно.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="tg-compose-text">Сообщение</Label>
              <Textarea
                id="tg-compose-text"
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={4}
                autoFocus={Boolean(initialUsername)}
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
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Отмена
          </Button>
          {foundExistingId ? (
            <Button onClick={openExisting}>
              <MessageSquare className="size-4" />
              Открыть диалог
            </Button>
          ) : (
            <Button onClick={send} disabled={pending || !canSend}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Send className="size-4" />
              )}
              Отправить
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Кнопка «Написать в ТГ» в панели фильтров инбокса — точка входа, когда лид
 * оставил ник в другом канале и нужно выйти на него в Telegram с рабочего
 * аккаунта. После отправки открывает созданный диалог в списке чатов.
 */
export function NewTelegramChatButton({
  onOpenConversation,
}: {
  onOpenConversation?: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex shrink-0 items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/20"
        title="Написать лиду в Telegram с рабочего аккаунта (по нику из другого канала)"
      >
        <Send className="size-3" />
        Написать в ТГ
      </button>
      {/* key: сбрасываем черновик при каждом открытии заново */}
      {open ? (
        <TelegramComposeDialog
          open={open}
          onOpenChange={setOpen}
          onCreated={onOpenConversation}
        />
      ) : null}
    </>
  )
}
