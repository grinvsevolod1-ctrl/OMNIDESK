'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { createBuyerAction } from '@/app/actions/admin-buyers'
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

export function CreateBuyerDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [createdPassword, setCreatedPassword] = useState<string | null>(null)
  const [createdUsername, setCreatedUsername] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function handleSubmit(formData: FormData) {
    startTransition(async () => {
      const res = await createBuyerAction(formData)
      if (res.ok) {
        toast.success(res.message)
        if (res.username) setCreatedUsername(res.username)
        if (res.password) setCreatedPassword(res.password)
        router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  function reset() {
    setCreatedPassword(null)
    setCreatedUsername(null)
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
          <Button variant="outline">
            <UserPlus className="size-4" />
            Новый медиабайер
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {createdPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>Медиабайер создан</DialogTitle>
              <DialogDescription>
                Передайте эти данные безопасным способом. Пароль показывается
                только один раз. Вход — через общую страницу входа.
              </DialogDescription>
            </DialogHeader>
            {createdUsername ? (
              <div className="rounded-lg border border-border bg-muted/40 p-4">
                <Label className="text-xs text-muted-foreground">Логин</Label>
                <div className="mt-2">
                  <code className="rounded-md bg-background px-3 py-2 font-mono text-sm">
                    {createdUsername}
                  </code>
                </div>
              </div>
            ) : null}
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
              <DialogTitle>Создать медиабайера</DialogTitle>
              <DialogDescription>
                Медиабайер видит статистику и лидов только своих источников
                трафика. Источники назначаются на странице «Источники».
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex max-h-[min(60dvh,34rem)] flex-col gap-4 overflow-y-auto overscroll-contain pr-1">
              <div className="flex flex-col gap-2">
                <Label htmlFor="buyer-name">Полное имя</Label>
                <Input
                  id="buyer-name"
                  name="name"
                  placeholder="Иван Петров"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="buyer-email">Email</Label>
                <Input
                  id="buyer-email"
                  name="email"
                  type="email"
                  placeholder="ivan@company.com"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="buyer-username">
                  Логин{' '}
                  <span className="font-normal text-muted-foreground">
                    (необязательно)
                  </span>
                </Label>
                <Input
                  id="buyer-username"
                  name="username"
                  type="text"
                  autoComplete="off"
                  placeholder="Оставьте пустым — возьмём из email"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="buyer-password">
                  Пароль{' '}
                  <span className="font-normal text-muted-foreground">
                    (необязательно)
                  </span>
                </Label>
                <Input
                  id="buyer-password"
                  name="password"
                  type="text"
                  placeholder="Оставьте пустым для автогенерации"
                  minLength={8}
                />
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
                  'Создать медиабайера'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
