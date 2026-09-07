'use client'

import { useMemo, useState, useTransition } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { secretCreateConversationAction } from '@/app/actions/admin-secret'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { TYPE_LABEL } from './utils'
import type { Channel, Manager } from '@/lib/types'

/** `datetime-local` value (local tz) for "now" — the default backdate. */
function nowLocalValue(): string {
  const d = new Date()
  d.setSeconds(0, 0)
  const off = d.getTimezoneOffset()
  return new Date(d.getTime() - off * 60_000).toISOString().slice(0, 16)
}

/**
 * Create a new conversation "as the client".
 *
 * The operator explicitly picks (1) the manager the thread is addressed to,
 * (2) one of THAT manager's channels, and (3) the time the client "wrote"
 * (defaults to now, may be backdated). Isolation is preserved because the
 * backing action assigns the conversation to the channel's owner, and we only
 * ever offer channels owned by the selected manager — so `manager_id` always
 * equals the chosen manager and the thread lands in exactly their inbox/chats.
 */
export function NewChatDialog({
  open,
  onOpenChange,
  channels,
  managers,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  channels: Channel[]
  managers: Manager[]
  /** Called with the created conversation id so the parent can open it. */
  onCreated: (id?: string) => void
}) {
  // Only channels with an owning manager are eligible (the action rejects
  // owner-less channels), so managers without any owned channel can't be chosen.
  const ownedChannels = useMemo(
    () => channels.filter((c) => c.managerId),
    [channels],
  )
  const eligibleManagers = useMemo(() => {
    const owners = new Set(ownedChannels.map((c) => c.managerId))
    return managers.filter((m) => owners.has(m.id))
  }, [ownedChannels, managers])

  const [managerId, setManagerId] = useState('')
  const [channelId, setChannelId] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactHandle, setContactHandle] = useState('')
  const [message, setMessage] = useState('')
  const [createdAt, setCreatedAt] = useState(nowLocalValue)
  const [pending, startTransition] = useTransition()

  // Channels for the currently selected manager (drives the channel picker).
  const managerChannels = useMemo(
    () => ownedChannels.filter((c) => c.managerId === managerId),
    [ownedChannels, managerId],
  )

  const reset = () => {
    setManagerId('')
    setChannelId('')
    setContactName('')
    setContactHandle('')
    setMessage('')
    setCreatedAt(nowLocalValue())
  }

  const onManagerChange = (v: string | null) => {
    setManagerId(v ?? '')
    setChannelId('') // channel list depends on the manager — clear stale pick
  }

  const submit = () => {
    if (!managerId) {
      toast.error('Выберите менеджера')
      return
    }
    if (!channelId || !contactName.trim() || !contactHandle.trim()) {
      toast.error('Заполните канал, имя и хэндл')
      return
    }
    const when = new Date(createdAt)
    if (Number.isNaN(when.getTime())) {
      toast.error('Некорректное время создания диалога')
      return
    }
    startTransition(async () => {
      const res = await secretCreateConversationAction({
        channelId,
        contactName: contactName.trim(),
        contactHandle: contactHandle.trim(),
        message: message.trim() || undefined,
        createdAt: when.toISOString(),
      })
      if (res.ok) {
        toast.success(res.message)
        reset()
        onCreated(res.id)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] max-w-md overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Новый диалог</DialogTitle>
          <DialogDescription>
            Создайте переписку от имени клиента. Сообщение появится в чатах
            выбранного менеджера как настоящее входящее — можно указать время
            обращения задним числом.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Менеджер</Label>
            <Select value={managerId} onValueChange={onManagerChange}>
              <SelectTrigger>
                <SelectValue placeholder="Кому адресован диалог" />
              </SelectTrigger>
              <SelectContent>
                {eligibleManagers.length === 0 ? (
                  <SelectItem value="none" disabled>
                    Нет менеджеров с каналами
                  </SelectItem>
                ) : (
                  eligibleManagers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Канал</Label>
            <Select
              value={channelId}
              onValueChange={(v) => setChannelId(v ?? '')}
              disabled={!managerId}
            >
              <SelectTrigger>
                <SelectValue
                  placeholder={
                    managerId ? 'Выберите канал' : 'Сначала выберите менеджера'
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {managerChannels.length === 0 ? (
                  <SelectItem value="none" disabled>
                    У менеджера нет каналов
                  </SelectItem>
                ) : (
                  managerChannels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {(TYPE_LABEL[c.type] ?? c.type) + ' · ' + c.name}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Имя контакта</Label>
              <Input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                placeholder="Иван Петров"
              />
            </div>
            <div className="grid gap-1.5">
              <Label className="text-xs text-muted-foreground">Хэндл</Label>
              <Input
                value={contactHandle}
                onChange={(e) => setContactHandle(e.target.value)}
                placeholder="id123456"
              />
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">
              Время обращения
            </Label>
            <Input
              type="datetime-local"
              value={createdAt}
              max={nowLocalValue()}
              onChange={(e) => setCreatedAt(e.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">
              Когда клиент «написал». По умолчанию — сейчас, можно задать задним
              числом.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">
              Первое сообщение (необязательно)
            </Label>
            <Textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Здравствуйте!"
              rows={3}
            />
          </div>
        </div>

        <DialogFooter className="mt-3">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            Отмена
          </Button>
          <Button onClick={submit} disabled={pending} className="gap-1.5">
            {pending && <Loader2 className="size-4 animate-spin" />}
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
