'use client'

import { useState, useTransition } from 'react'
import {
  Ban,
  Check,
  Copy,
  KeyRound,
  MoreHorizontal,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  deleteManagerAction,
  resetManagerPasswordAction,
  setManagerStatusAction,
} from '@/app/actions/managers'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Label } from '@/components/ui/label'
import type { Manager } from '@/lib/types'

export function ManagerActions({ manager }: { manager: Manager }) {
  const [pending, startTransition] = useTransition()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [newPassword, setNewPassword] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  function toggleStatus() {
    const next = manager.status === 'active' ? 'blocked' : 'active'
    startTransition(async () => {
      const res = await setManagerStatusAction(manager.id, next)
      res.ok ? toast.success(res.message) : toast.error(res.message)
    })
  }

  function resetPassword() {
    startTransition(async () => {
      const res = await resetManagerPasswordAction(manager.id)
      if (res.ok && res.password) {
        setNewPassword(res.password)
      } else {
        toast.error(res.message)
      }
    })
  }

  function doDelete() {
    startTransition(async () => {
      const res = await deleteManagerAction(manager.id)
      if (res.ok) {
        toast.success(res.message)
        setConfirmDelete(false)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button variant="ghost" size="icon-sm" aria-label="Действия с менеджером">
              <MoreHorizontal className="size-4" />
            </Button>
          }
        />
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuItem
            onClick={toggleStatus}
            disabled={pending}
            render={
              <span className="flex cursor-pointer items-center gap-2">
                {manager.status === 'active' ? (
                  <>
                    <Ban className="size-4" />
                    Заблокировать
                  </>
                ) : (
                  <>
                    <ShieldCheck className="size-4" />
                    Разблокировать
                  </>
                )}
              </span>
            }
          />
          <DropdownMenuItem
            onClick={resetPassword}
            disabled={pending}
            render={
              <span className="flex cursor-pointer items-center gap-2">
                <KeyRound className="size-4" />
                Сбросить пароль
              </span>
            }
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
            render={
              <span className="flex cursor-pointer items-center gap-2">
                <Trash2 className="size-4" />
                Удалить
              </span>
            }
          />
        </DropdownMenuContent>
      </DropdownMenu>

      {/* New password dialog */}
      <Dialog
        open={Boolean(newPassword)}
        onOpenChange={(o) => {
          if (!o) {
            setNewPassword(null)
            setCopied(false)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Пароль сброшен</DialogTitle>
            <DialogDescription>
              Передайте новый пароль для {manager.name} безопасным способом. Он
              показывается только один раз.
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-lg border border-border bg-muted/40 p-4">
            <Label className="text-xs text-muted-foreground">Новый пароль</Label>
            <div className="mt-2 flex items-center gap-2">
              <code className="flex-1 rounded-md bg-background px-3 py-2 font-mono text-sm">
                {newPassword}
              </code>
              <Button
                variant="outline"
                size="icon"
                onClick={() => {
                  if (newPassword) navigator.clipboard.writeText(newPassword)
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
            <Button onClick={() => setNewPassword(null)}>Готово</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Подтверждение удаления */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Удалить менеджера?</DialogTitle>
            <DialogDescription>
              Это навсегда удалит {manager.name} и все подключённые им каналы.
              Действие нельзя отменить.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>
              Отмена
            </Button>
            <Button variant="destructive" onClick={doDelete} disabled={pending}>
              Удалить менеджера
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
