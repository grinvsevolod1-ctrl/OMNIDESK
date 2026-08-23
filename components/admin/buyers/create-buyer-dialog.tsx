'use client'

import { createBuyerAction } from '@/app/actions/admin-buyers'
import { CreateAccountDialog } from '@/components/admin/create-account-dialog'

/** Тонкая обёртка над общим CreateAccountDialog: медиабайер. */
export function CreateBuyerDialog() {
  return (
    <CreateAccountDialog
      triggerLabel="Новый медиабайер"
      title="Создать медиабайера"
      description="Медиабайер видит статистику и лидов только своих источников трафика. Источники назначаются на странице «Источники»."
      createdTitle="Медиабайер создан"
      createdDescription="Передайте эти данные безопасным способом. Пароль показывается только один раз. Вход — через общую страницу входа."
      submitLabel="Создать медиабайера"
      idPrefix="buyer"
      action={createBuyerAction}
      refreshOnSuccess
    />
  )
}
