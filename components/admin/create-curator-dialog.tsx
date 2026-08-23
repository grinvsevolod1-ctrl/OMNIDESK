'use client'

import { useState } from 'react'
import { createCuratorAction } from '@/app/actions/managers'
import { CreateAccountDialog } from '@/components/admin/create-account-dialog'
import { CityListInput } from '@/components/shared/city-list-input'
import { Label } from '@/components/ui/label'

/**
 * Тонкая обёртка над общим CreateAccountDialog: менеджер по кадрам.
 * Роль-специфичное поле — список городов (CityListInput), его состояние
 * живёт здесь и сбрасывается через onReset при закрытии диалога.
 */
export function CreateCuratorDialog() {
  const [cities, setCities] = useState<string[]>([''])

  return (
    <CreateAccountDialog
      triggerLabel="Новый менеджер по кадрам"
      title="Создать менеджера по кадрам"
      description="Добавьте менеджера по кадрам и укажите города, за которые он отвечает."
      createdTitle="Менеджер по кадрам создан"
      submitLabel="Создать менеджера по кадрам"
      idPrefix="curator"
      action={createCuratorAction}
      onReset={() => setCities([''])}
      extraFieldsAfterEmail={
        <div className="flex flex-col gap-2">
          <Label htmlFor="curator-city">Города</Label>
          <CityListInput
            idPrefix="curator-city"
            name="city"
            cities={cities}
            onChange={setCities}
            required
          />
        </div>
      }
    />
  )
}
