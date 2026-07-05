'use client'

import { useState, useTransition } from 'react'
import { Check, Copy, Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { createManagerAction } from '@/app/actions/managers'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function CreateManagerDialog() {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [createdPassword, setCreatedPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await createManagerAction(formData)
      if (res.ok) {
        toast.success(res.message)
        if (res.password) setCreatedPassword(res.password)
      } else {
        toast.error(res.message)
      }
    })
  }

  function reset() {
    setCreatedPassword(null)
    setCopied(false)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <UserPlus className="size-4" />
            Новый менеджер
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {createdPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>Менеджер создан</DialogTitle>
              <DialogDescription>
                Передайте эти данные безопасным способом. Пароль показывается
                только один раз.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-border bg-muted/40 p-4">
              <Label className="text-xs text-muted-foreground">
                Временный пароль
              </Label>
              <div className="mt-2 flex items-center gap-2">
                <code className="flex-1 rounded-md bg-background px-3 py-2 font-mono text-sm">
                  {createdPassword}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => {
                    navigator.clipboard.writeText(createdPassword)
                    setCopied(true)
                    toast.success('Пароль скопирован')
                    setTimeout(() => setCopied(false), 1500)
                  }}
                  aria-label="Скопировать пароль"
                >
                  {copied ? (
                    <Check className="size-4" />
                  ) : (
                    <Copy className="size-4" />
                  )}
                </Button>
              </div>
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  setOpen(false)
                  reset()
                }}
              >
                Готово
              </Button>
            </DialogFooter>
          </>
        ) : (
          <form action={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Создать менеджера</DialogTitle>
              <DialogDescription>
                Добавьте участника команды, который сможет подключать каналы и
                работать с ними.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="name">Полное имя</Label>
                <Input
                  id="name"
                  name="name"
                  placeholder="Иван Петров"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="ivan@company.com"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">
                  Пароль{' '}
                  <span className="font-normal text-muted-foreground">
                    (необязательно)
                  </span>
                </Label>
                <Input
                  id="password"
                  name="password"
                  type="text"
                  placeholder="Оставьте пустым для автогенерации"
                  minLength={8}
                />
                <p className="text-xs text-muted-foreground">
                  Оставьте поле пустым — мы сгенерируем надёжный пароль за вас.
                </p>
              </div>
            </div>
            <DialogFooter>
              <DialogClose
                render={
                  <Button variant="outline" type="button">
                    Отмена
                  </Button>
                }
              />
              <Button type="submit" disabled={pending}>
                {pending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Создаём…
                  </>
                ) : (
                  'Создать менеджера'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
