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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { TYPE_LABEL } from './utils'
import { ScenarioPicker } from './scenario-picker'
import type { Channel } from '@/lib/types'

/**
 * Create a new conversation "as the client". Only channels that have an owning
 * manager are selectable — the god-console action rejects owner-less channels.
 * On success the parent selects the freshly created thread.
 */
export function NewChatDialog({
  open,
  onOpenChange,
  channels,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  channels: Channel[]
  /** Called with the created conversation id so the parent can open it. */
  onCreated: (id?: string) => void
}) {
  const ownedChannels = useMemo(
    () => channels.filter((c) => c.managerId),
    [channels],
  )
  const [channelId, setChannelId] = useState('')
  const [contactName, setContactName] = useState('')
  const [contactHandle, setContactHandle] = useState('')
  const [message, setMessage] = useState('')
  const [pending, startTransition] = useTransition()

  const reset = () => {
    setChannelId('')
    setContactName('')
    setContactHandle('')
    setMessage('')
  }

  const submit = () => {
    if (!channelId || !contactName.trim() || !contactHandle.trim()) {
      toast.error('Заполните канал, имя и хэндл')
      return
    }
    startTransition(async () => {
      const res = await secretCreateConversationAction({
        channelId,
        contactName: contactName.trim(),
        contactHandle: contactHandle.trim(),
        message: message.trim() || undefined,
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
            Создайте переписку от имени клиента. Сообщение придёт менеджеру канала
            как настоящее входящее.
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="manual">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="manual">{'Вручную'}</TabsTrigger>
            <TabsTrigger value="scenarios">{'Сценарии'}</TabsTrigger>
          </TabsList>

          {/* -------- Tab 2: 1000 generated candidate scenarios -------- */}
          <TabsContent value="scenarios" className="mt-3">
            <ScenarioPicker channels={channels} onCreated={onCreated} />
          </TabsContent>

          {/* ------------------- Tab 1: manual form -------------------- */}
          <TabsContent value="manual" className="mt-3">
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label className="text-xs text-muted-foreground">Канал</Label>
            <Select value={channelId} onValueChange={(v) => setChannelId(v ?? '')}>
              <SelectTrigger>
                <SelectValue placeholder="Выберите канал" />
              </SelectTrigger>
              <SelectContent>
                {ownedChannels.length === 0 ? (
                  <SelectItem value="none" disabled>
                    Нет каналов с менеджером
                  </SelectItem>
                ) : (
                  ownedChannels.map((c) => (
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
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
