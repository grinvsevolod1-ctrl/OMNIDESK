'use client'

import { createManagerAction } from '@/app/actions/managers'
import { CreateAccountDialog } from '@/components/admin/create-account-dialog'

/** Тонкая обёртка над общим CreateAccountDialog: менеджер продаж. */
export function CreateManagerDialog() {
  return (
    <CreateAccountDialog
      triggerLabel="Новый менеджер"
      triggerVariant="default"
      title="Создать менеджера"
      description="Добавьте участника команды, который сможет подключать каналы и работать с ними."
      createdTitle="Менеджер создан"
      submitLabel="Создать менеджера"
      idPrefix="manager"
      action={createManagerAction}
    />
  )
}
