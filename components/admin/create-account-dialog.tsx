'use client'

import { useState, useTransition, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { Check, Copy, Loader2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
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

/** Результат server action создания аккаунта (общий для всех ролей). */
export interface CreateAccountResult {
  ok: boolean
  message: string
  username?: string | null
  password?: string | null
}

/**
 * Единый диалог «создать аккаунт с временным паролем» для всех ролей
 * админки: менеджер, менеджер по кадрам, руководитель, медиабайер.
 * Раньше это были четыре почти идентичные копии (~200 строк каждая);
 * различия вынесены в пропсы:
 *
 * - `action` — server action роли (FormData -> CreateAccountResult);
 * - `extraFieldsAfterEmail` / `extraFieldsAfterPassword` — слоты для
 *   роль-специфичных полей (города у менеджера по кадрам, право
 *   редактирования у руководителя). Состояние этих полей живёт в
 *   обёртке; при закрытии диалога она получает onReset;
 * - `beforeSubmit` — шанс дописать в FormData значения из состояния
 *   обёртки (например canEdit руководителя);
 * - `refreshOnSuccess` — router.refresh() после создания (страницы,
 *   которые показывают список без собственного пуллинга).
 *
 * Экран «создано» одинаков для всех: логин + временный пароль с
 * кнопкой копирования, пароль показывается только один раз.
 */
export function CreateAccountDialog({
  triggerLabel,
  triggerVariant = 'outline',
  title,
  description,
  createdTitle,
  createdDescription = 'Передайте эти данные безопасным способом. Пароль показывается только один раз.',
  submitLabel,
  idPrefix,
  action,
  refreshOnSuccess = false,
  extraFieldsAfterEmail,
  extraFieldsAfterPassword,
  beforeSubmit,
  onReset,
}: {
  triggerLabel: string
  triggerVariant?: 'default' | 'outline'
  title: string
  description: string
  createdTitle: string
  createdDescription?: string
  submitLabel: string
  /** Префикс для id инпутов, чтобы label/аналитика не пересекались. */
  idPrefix: string
  action: (formData: FormData) => Promise<CreateAccountResult>
  refreshOnSuccess?: boolean
  extraFieldsAfterEmail?: ReactNode
  extraFieldsAfterPassword?: ReactNode
  beforeSubmit?: (formData: FormData) => void
  /** Сброс роль-специфичного состояния обёртки при закрытии. */
  onReset?: () => void
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [createdPassword, setCreatedPassword] = useState<string | null>(null)
  const [createdUsername, setCreatedUsername] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function handleSubmit(formData: FormData) {
    beforeSubmit?.(formData)
    startTransition(async () => {
      const res = await action(formData)
      if (res.ok) {
        toast.success(res.message)
        if (res.username) setCreatedUsername(res.username)
        if (res.password) setCreatedPassword(res.password)
        if (refreshOnSuccess) router.refresh()
      } else {
        toast.error(res.message)
      }
    })
  }

  function reset() {
    setCreatedPassword(null)
    setCreatedUsername(null)
    setCopied(false)
    onReset?.()
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
          <Button variant={triggerVariant}>
            <UserPlus className="size-4" />
            {triggerLabel}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        {createdPassword ? (
          <>
            <DialogHeader>
              <DialogTitle>{createdTitle}</DialogTitle>
              <DialogDescription>{createdDescription}</DialogDescription>
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
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{description}</DialogDescription>
            </DialogHeader>
            {/* Контент формы скроллится внутри: при длинных роль-специфичных
                блоках диалог не растягивает страницу, шапка и кнопки всегда
                на экране. */}
            <div className="my-4 flex max-h-[min(60dvh,34rem)] flex-col gap-4 overflow-y-auto overscroll-contain pr-1">
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${idPrefix}-name`}>Полное имя</Label>
                <Input
                  id={`${idPrefix}-name`}
                  name="name"
                  placeholder="Иван Петров"
                  required
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${idPrefix}-email`}>Email</Label>
                <Input
                  id={`${idPrefix}-email`}
                  name="email"
                  type="email"
                  placeholder="ivan@company.com"
                  required
                />
              </div>
              {extraFieldsAfterEmail}
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${idPrefix}-username`}>
                  Логин{' '}
                  <span className="font-normal text-muted-foreground">
                    (необязательно)
                  </span>
                </Label>
                <Input
                  id={`${idPrefix}-username`}
                  name="username"
                  type="text"
                  autoComplete="off"
                  placeholder="Оставьте пустым — возьмём из email"
                />
                <p className="text-xs text-muted-foreground">
                  Можно входить и по email, и по логину. По умолчанию логин —
                  часть email до «@».
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor={`${idPrefix}-password`}>
                  Пароль{' '}
                  <span className="font-normal text-muted-foreground">
                    (необязательно)
                  </span>
                </Label>
                <Input
                  id={`${idPrefix}-password`}
                  name="password"
                  type="text"
                  placeholder="Оставьте пустым для автогенерации"
                  minLength={8}
                />
                <p className="text-xs text-muted-foreground">
                  Оставьте поле пустым — мы сгенерируем надёжный пароль за вас.
                </p>
              </div>
              {extraFieldsAfterPassword}
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
                  submitLabel
                )}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
