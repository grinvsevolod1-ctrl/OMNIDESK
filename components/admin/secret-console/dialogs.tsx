'use client'

/**
 * Create / edit conversation dialogs for the god-console, extracted from the
 * secret-console monolith. Self-contained forms: each owns its local form
 * state and calls the matching secret admin action, notifying the parent via
 * onCreated/onSaved callbacks.
 */

import { useState, useTransition } from 'react'
import { toast } from 'sonner'
import { CheckCheck, Loader2, Plus } from 'lucide-react'
import {
  secretCreateConversationAction,
  secretUpdateConversationAction,
  type ConversationWithManager,
} from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import type { Channel, Manager } from '@/lib/types'
import { TYPE_LABEL } from '@/components/admin/secret-console/utils'

export function CreateConversationDialog({
  open,
  onOpenChange,
  channels,
  pending,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  channels: Channel[]
  pending: boolean
  onCreated: (id: string | null) => void
}) {
  const [form, setForm] = useState({
    channelId: '',
    contactName: '',
    contactHandle: '',
    message: '',
  })
  const [, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      const res = await secretCreateConversationAction(form)
      if (res.ok) {
        toast.success(res.message)
        setForm({ channelId: '', contactName: '', contactHandle: '', message: '' })
        onCreated(null)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Новый диалог</DialogTitle>
          <DialogDescription>
            Создайте переписку от имени клиента. Диалог привяжется к каналу и его
            менеджеру-владельцу и появится в его входящих.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Канал</Label>
            <Select
              value={form.channelId}
              onValueChange={(v) => setForm({ ...form, channelId: v ?? '' })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Выберите канал" />
              </SelectTrigger>
              <SelectContent>
                {channels.map((ch) => (
                  <SelectItem key={ch.id} value={ch.id}>
                    {ch.name} · {TYPE_LABEL[ch.type] ?? ch.type}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="grid gap-1.5">
              <Label>Имя клиента</Label>
              <Input
                value={form.contactName}
                onChange={(e) => setForm({ ...form, contactName: e.target.value })}
                placeholder="Иван Петров"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Хэндл</Label>
              <Input
                value={form.contactHandle}
                onChange={(e) => setForm({ ...form, contactHandle: e.target.value })}
                placeholder="@user / +7…"
              />
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label>Первое сообщение от клиента</Label>
            <Textarea
              value={form.message}
              onChange={(e) => setForm({ ...form, message: e.target.value })}
              placeholder="Необязательно"
              className="resize-none"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={pending} onClick={submit} className="gap-1.5">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            Создать
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/* ---------------------------- Edit dialog ----------------------------- */

export function EditConversationDialog({
  open,
  onOpenChange,
  conversation,
  managers,
  pending,
  onSaved,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  conversation: ConversationWithManager
  managers: Manager[]
  pending: boolean
  onSaved: () => void
}) {
  const [form, setForm] = useState({
    contactName: conversation.contactName,
    contactHandle: conversation.contactHandle,
    managerId: conversation.managerId,
  })
  const [, startTransition] = useTransition()

  function submit() {
    startTransition(async () => {
      const res = await secretUpdateConversationAction({
        id: conversation.id,
        contactName: form.contactName,
        contactHandle: form.contactHandle,
        managerId: form.managerId,
      })
      if (res.ok) {
        toast.success(res.message)
        onSaved()
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Изменить диалог</DialogTitle>
          <DialogDescription>
            Отредактируйте данные клиента или переназначьте диалог другому менеджеру.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Имя клиента</Label>
            <Input
              value={form.contactName}
              onChange={(e) => setForm({ ...form, contactName: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Хэндл</Label>
            <Input
              value={form.contactHandle}
              onChange={(e) => setForm({ ...form, contactHandle: e.target.value })}
            />
          </div>
          <div className="grid gap-1.5">
            <Label>Менеджер</Label>
            <Select
              value={form.managerId}
              onValueChange={(v) => setForm({ ...form, managerId: v ?? form.managerId })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Менеджер" />
              </SelectTrigger>
              <SelectContent>
                {managers.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Отмена
          </Button>
          <Button disabled={pending} onClick={submit} className="gap-1.5">
            {pending ? <Loader2 className="size-4 animate-spin" /> : <CheckCheck className="size-4" />}
            Сохранить
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
