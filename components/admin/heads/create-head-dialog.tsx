'use client'

import { useState } from 'react'
import { createHeadAction } from '@/app/actions/admin-heads'
import { CreateAccountDialog } from '@/components/admin/create-account-dialog'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

/**
 * Тонкая обёртка над общим CreateAccountDialog: руководитель группы.
 * Роль-специфичное поле — право «просмотр и редактирование» (canEdit),
 * значение дописывается в FormData через beforeSubmit.
 */
export function CreateHeadDialog() {
  const [canEdit, setCanEdit] = useState(false)

  return (
    <CreateAccountDialog
      triggerLabel="Новый руководитель"
      title="Создать руководителя"
      description="Руководитель видит лидов только закреплённых за ним менеджеров по кадрам. Состав группы настраивается после создания."
      createdTitle="Руководитель создан"
      createdDescription="Передайте эти данные безопасным способом. Пароль показывается только один раз. Вход — через общую страницу входа."
      submitLabel="Создать руководителя"
      idPrefix="head"
      action={createHeadAction}
      refreshOnSuccess
      beforeSubmit={(fd) => fd.set('canEdit', canEdit ? 'true' : 'false')}
      onReset={() => setCanEdit(false)}
      extraFieldsAfterPassword={
        <div className="flex items-center justify-between rounded-lg border border-border p-3">
          <div className="flex flex-col gap-0.5 pr-3">
            <Label htmlFor="head-can-edit">Просмотр и редактирование</Label>
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
      }
    />
  )
}
