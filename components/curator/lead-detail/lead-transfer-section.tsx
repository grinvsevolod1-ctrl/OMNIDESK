'use client'

import { useState, useTransition } from 'react'
import { ArrowRightLeft } from 'lucide-react'
import { toast } from 'sonner'
import useSWR from 'swr'
import {
  headTransferLeadAction,
  listMyGroupCuratorsAction,
} from '@/app/actions/heads'
import {
  listActiveCuratorsAction,
  transferLeadAdminAction,
  transferMyLeadAction,
} from '@/app/actions/lead-cards'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/**
 * Передача лида другому менеджеру по кадрам. Список коллег грузится лениво —
 * только когда секция раскрыта. Себя в списке нет: передать лид самому себе
 * нельзя (и сервер это тоже отклонит). variant='head' — руководитель
 * переводит лид между кураторами СВОЕЙ группы (свой action и свой список).
 * variant='admin' — админ передаёт лид ЛЮБОМУ активному менеджеру по кадрам
 * (свой action без проверки владельца).
 */
export function LeadTransferSection({
  leadCardId,
  currentCuratorId,
  onTransferred,
  variant = 'curator',
}: {
  leadCardId: string
  /** Владелец карточки: исключается из списка получателей. */
  currentCuratorId: string | null
  onTransferred: () => void
  variant?: 'curator' | 'head' | 'admin'
}) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [pending, startTransition] = useTransition()

  const { data: curators, isLoading } = useSWR(
    open ? ['transfer-curators', variant] : null,
    () =>
      variant === 'head'
        ? listMyGroupCuratorsAction()
        : listActiveCuratorsAction(),
    { revalidateOnFocus: false },
  )
  const options = (curators ?? []).filter((c) => c.id !== currentCuratorId)

  function transfer() {
    if (!target) return
    startTransition(async () => {
      const res =
        variant === 'head'
          ? await headTransferLeadAction({ leadCardId, toCuratorId: target })
          : variant === 'admin'
            ? await transferLeadAdminAction({
                leadCardId,
                curatorId: target,
              })
            : await transferMyLeadAction({ leadCardId, toCuratorId: target })
      if (res.ok) {
        toast.success(res.message)
        onTransferred()
      } else {
        toast.error(res.message)
      }
    })
  }

  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => setOpen(true)}
      >
        <ArrowRightLeft className="size-4" />
        Передать лид коллеге
      </Button>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold">Передать лид коллеге</p>
      <p className="text-xs text-muted-foreground">
        Лид перейдёт выбранному менеджеру по кадрам, статус сбросится — он
        подтвердит его как обычно.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Select value={target} onValueChange={(v) => setTarget(v ?? '')}>
          <SelectTrigger className="w-full min-w-0 sm:w-64" size="sm">
            <SelectValue
              placeholder={
                isLoading ? 'Загрузка…' : 'Выберите менеджера по кадрам'
              }
            />
          </SelectTrigger>
          <SelectContent>
            {options.length === 0 && !isLoading ? (
              <div className="px-2 py-1.5 text-xs text-muted-foreground">
                Нет других активных менеджеров по кадрам
              </div>
            ) : (
              options.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={!target || pending}
            onClick={transfer}
          >
            Передать
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => {
              setOpen(false)
              setTarget('')
            }}
          >
            Отмена
          </Button>
        </div>
      </div>
    </div>
  )
}
