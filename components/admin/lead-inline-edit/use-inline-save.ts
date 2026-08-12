'use client'

import { useTransition } from 'react'
import { toast } from 'sonner'

/**
 * Общий флоу сохранения инлайн-редакторов лида: transition + toast + колбэк.
 * Все четыре редактора (статус, город, текстовое поле, удаление) повторяли
 * один и тот же паттерн — здесь он в одном месте.
 */
export function useInlineSave() {
  const [pending, startTransition] = useTransition()

  function run(
    fn: () => Promise<{ ok: boolean; message?: string }>,
    opts?: { successMessage?: string; onOk?: () => void },
  ) {
    startTransition(async () => {
      const res = await fn()
      if (res.ok) {
        toast.success(opts?.successMessage ?? res.message ?? 'Сохранено')
        opts?.onOk?.()
      } else {
        toast.error(res.message ?? 'Ошибка')
      }
    })
  }

  return { pending, run }
}
