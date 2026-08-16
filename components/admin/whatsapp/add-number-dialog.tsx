'use client'

import { useState, useTransition } from 'react'
import { Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { addWhatsappNumberAction } from '@/app/actions/whatsapp'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import type { Manager } from '@/lib/types'
import { UNASSIGNED } from './types'

/** Manual number registration by Phone Number ID (verified via Graph API). */
export function AddNumberDialog({
  managers,
  disabled,
}: {
  managers: Manager[]
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [assignTo, setAssignTo] = useState(UNASSIGNED)
  const [pending, startTransition] = useTransition()

  function submit(formData: FormData) {
    const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim()
    const name = String(formData.get('name') ?? '').trim()
    startTransition(async () => {
      const res = await addWhatsappNumberAction({
        phoneNumberId,
        name,
        managerId: assignTo === UNASSIGNED ? null : assignTo,
      })
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setAssignTo(UNASSIGNED)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button disabled={disabled}>
            <Plus className="size-4" />
            Добавить вручную
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={submit}>
          <DialogHeader>
            <DialogTitle>Добавить номер WhatsApp</DialogTitle>
            <DialogDescription>
              Укажите Phone Number ID из Meta. Номер проверяется через Graph API
              перед сохранением.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="wa-add-id">Phone Number ID</Label>
              <Input
                id="wa-add-id"
                name="phoneNumberId"
                placeholder="1162878263578339"
                className="font-mono text-sm"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wa-add-name">Название</Label>
              <Input
                id="wa-add-name"
                name="name"
                placeholder="Необязательно — подставится из Meta"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Назначить менеджеру</Label>
              <Select
                value={assignTo}
                onValueChange={(v) => setAssignTo(v ?? UNASSIGNED)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Без назначения</SelectItem>
                  {managers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Добавить
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
