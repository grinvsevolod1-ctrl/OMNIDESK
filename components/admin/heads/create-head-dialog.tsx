'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { createHeadAction } from '@/app/actions/admin-heads'
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
import { Switch } from '@/components/ui/switch'

export function CreateHeadDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [canEdit, setCanEdit] = useState(false)
  const [createdPassword, setCreatedPassword] = useState<string | null>(null)
  const [createdUsername, setCreatedUsername] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function handleSubmit(formData: FormData) {
    formData.set('canEdit', canEdit ? 'true' : 'false')
    startTransition(async () => {
      const res = await createHeadAction(formData)
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
    setCanEdit(false)
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
            Новый руководитель
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {createdPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>Руководитель создан</DialogTitle>
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
              <DialogTitle>Создать руководителя</DialogTitle>
              <DialogDescription>
                Руководитель видит лидов только закреплённых за ним менеджеров
                по кадрам. Состав группы настраивается после создания.
              </DialogDescription>
            </DialogHeader>
            <div className="my-4 flex max-h-[min(60dvh,34rem)] flex-col gap-4 overflow-y-auto overscroll-contain pr-1">
              <div className="flex flex-col gap-2">
                <Label htmlFor="head-name">Полное имя</Label>
                <Input
                  id="head-name"
                  name="name"
                  placeholder="Иван Петров"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="head-email">Email</Label>
                <Input
                  id="head-email"
                  name="email"
                  type="email"
                  placeholder="ivan@company.com"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="head-username">
                  Логин{' '}
                  <span className="font-normal text-muted-foreground">
                    (необязательно)
                  </span>
                </Label>
                <Input
                  id="head-username"
                  name="username"
                  type="text"
                  autoComplete="off"
                  placeholder="Оставьте пустым — возьмём из email"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="head-password">
                  Пароль{' '}
                  <span className="font-normal text-muted-foreground">
                    (необязательно)
                  </span>
                </Label>
                <Input
                  id="head-password"
                  name="password"
                  type="text"
                  placeholder="Оставьте пустым для автогенерации"
                  minLength={8}
                />
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div className="flex flex-col gap-0.5 pr-3">
                  <Label htmlFor="head-can-edit">
                    Просмотр и редактирование
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    Выключено — только просмотр лидов группы. Включено — правка
                    полей, статусов, комментарии и передача лидов.
                  </p>
                </div>
                <Switch
                  id="head-can-edit"
                  checked={canEdit}
                  onCheckedChange={setCanEdit}
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
                  'Создать руководителя'
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
