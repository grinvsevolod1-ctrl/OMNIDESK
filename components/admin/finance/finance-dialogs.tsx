'use client'

/**
 * Finance-admin entity dialogs: source/resource and ad-account editors plus a
 * generic confirm dialog. Money-movement dialogs live in finance-entry-dialogs.tsx
 * and the shared currency dropdown in finance-currency-select.tsx; both are
 * re-exported below so finance-admin.tsx keeps a single import site.
 */

import { useEffect, useState } from 'react'
import { Link as LinkIcon, Loader2, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import {
  AD_PLATFORMS,
  AD_STATUSES,
  type AdPlatform,
  type FinanceAdAccount,
  type FinanceResource,
} from '@/lib/finance-types'
import {
  AD_STATUS_META,
  PLATFORM_META,
} from '@/components/admin/finance/finance-utils'
import { CurrencySelect } from '@/components/admin/finance/finance-currency-select'

export function ResourceDialog({
  state,
  pending,
  onClose,
  onSubmit,
  onUpdate,
  onDelete,
}: {
  state:
    | { mode: 'create' }
    | { mode: 'edit'; resource: FinanceResource }
    | null
  pending: boolean
  onClose: () => void
  onSubmit: (fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
  onDelete: (resource: FinanceResource) => void
}) {
  const editing = state?.mode === 'edit' ? state.resource : null
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else onSubmit(fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить источник лидов' : 'Новый источник лидов'}
            </DialogTitle>
            <DialogDescription>
              Источник лидов — это площадка (например, site.com), внутри которой
              вы ведёте рекламные кабинеты и расходы. Все суммы учитываются в USD.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="res-name">Название</Label>
              <Input
                id="res-name"
                name="name"
                defaultValue={editing?.name ?? ''}
                placeholder="Например, site.com или «Лендинг Весна»"
                autoFocus
                required
              />
              <p className="text-xs text-muted-foreground">
                Короткое узнаваемое имя, по которому вы найдёте источник в списке.
              </p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="res-desc">Описание</Label>
              <Textarea
                id="res-desc"
                name="description"
                defaultValue={editing?.description ?? ''}
                placeholder="Необязательно: что это за источник, откуда идут лиды, кто ведёт"
                rows={3}
              />
              <p className="text-xs text-muted-foreground">
                Пара слов для контекста — поможет вспомнить детали позже.
              </p>
            </div>
            {editing ? (
              <div className="space-y-2">
                <Label htmlFor="res-archived">Статус</Label>
                <Select
                  name="archived"
                  defaultValue={editing.archived ? 'true' : 'false'}
                >
                  <SelectTrigger id="res-archived" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="false">Активен</SelectItem>
                    <SelectItem value="true">В архиве</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
          </div>
          <DialogFooter className="flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {editing ? (
              <Button
                type="button"
                variant="ghost"
                className="text-destructive hover:text-destructive"
                onClick={() => onDelete(editing)}
              >
                <Trash2 className="size-4" /> Удалить
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <DialogClose
                render={
                  <Button type="button" variant="outline">
                    Отмена
                  </Button>
                }
              />
              <Button type="submit" disabled={pending}>
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : editing ? (
                  'Сохранить'
                ) : (
                  'Добавить'
                )}
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function AdAccountDialog({
  state,
  pending,
  onClose,
  onCreate,
  onUpdate,
}: {
  state:
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; account: FinanceAdAccount }
    | null
  pending: boolean
  onClose: () => void
  onCreate: (resourceId: string, fd: FormData) => void
  onUpdate: (id: string, fd: FormData) => void
}) {
  const editing = state?.mode === 'edit' ? state.account : null
  const [externalEnabled, setExternalEnabled] = useState(false)
  const [platform, setPlatform] = useState<AdPlatform>('yandex_direct')

  // This reusable dialog remains mounted; a changed entity must reset its draft.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (state?.mode === 'edit') {
      setExternalEnabled(state.account.externalEnabled)
      setPlatform(state.account.platform)
    } else if (state?.mode === 'create') {
      setExternalEnabled(false)
      setPlatform('yandex_direct')
    }
  }, [state])
  /* eslint-enable react-hooks/set-state-in-effect */

  const canIntegrate = platform === 'yandex_direct'

  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            if (editing) onUpdate(editing.id, fd)
            else if (state?.mode === 'create') onCreate(state.resourceId, fd)
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {editing ? 'Изменить кабинет' : 'Новый рекламный кабинет'}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label htmlFor="acc-name">Название</Label>
              <Input
                id="acc-name"
                name="name"
                defaultValue={editing?.name ?? ''}
                placeholder="Основной кабинет"
                autoFocus
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="acc-platform">Площадка</Label>
                <Select
                  name="platform"
                  value={platform}
                  onValueChange={(v) => setPlatform(v as AdPlatform)}
                >
                  <SelectTrigger id="acc-platform" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AD_PLATFORMS.map((p) => (
                      <SelectItem key={p} value={p}>
                        {PLATFORM_META[p]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="acc-status">Статус</Label>
                <Select
                  name="status"
                  defaultValue={editing?.status ?? 'active'}
                >
                  <SelectTrigger id="acc-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {AD_STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {AD_STATUS_META[s].label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="acc-ref">Логин / номер</Label>
                <Input
                  id="acc-ref"
                  name="accountRef"
                  defaultValue={editing?.accountRef ?? ''}
                  placeholder="ID кабинета"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="acc-currency">Валюта</Label>
                <CurrencySelect
                  name="currency"
                  defaultValue={editing?.currency ?? 'RUB'}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="acc-note">Заметка</Label>
              <Textarea
                id="acc-note"
                name="note"
                defaultValue={editing?.note ?? ''}
                rows={2}
              />
            </div>

            {/* Прямая интеграция с Яндекс.Директом */}
            <div className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <LinkIcon className="size-4 text-muted-foreground" />
                    <Label
                      htmlFor="acc-external"
                      className="cursor-pointer font-medium"
                    >
                      Интеграция с Яндекс.Директом
                    </Label>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {canIntegrate
                      ? 'Статистика (показы, клики, лиды, расход) подтягивается автоматически. Пополнения остаются ручными.'
                      : 'Доступно только для площадки «Яндекс Директ».'}
                  </p>
                </div>
                <Switch
                  id="acc-external"
                  name="externalEnabled"
                  checked={externalEnabled}
                  onCheckedChange={setExternalEnabled}
                  disabled={!canIntegrate}
                />
              </div>

              {externalEnabled && canIntegrate ? (
                <div className="mt-3 space-y-3 border-t border-border pt-3">
                  <div className="space-y-2">
                    <Label htmlFor="acc-yandex-login">Логин клиента (необяз.)</Label>
                    <Input
                      id="acc-yandex-login"
                      name="yandexLogin"
                      defaultValue={editing?.yandexLogin ?? ''}
                      placeholder="agency-client-login"
                    />
                    <p className="text-xs text-muted-foreground">
                      Для агентских аккаунтов — логин управляемого клиента.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="acc-yandex-token">OAuth-токен</Label>
                    <Input
                      id="acc-yandex-token"
                      name="yandexToken"
                      type="password"
                      autoComplete="off"
                      placeholder={
                        editing?.hasToken
                          ? '•••••••• (сохранён — оставьте пустым, чтобы не менять)'
                          : 'y0_AgAAAA...'
                      }
                      required={!editing?.hasToken}
                    />
                    <p className="text-xs text-muted-foreground">
                      Токен хранится в зашифрованном виде и не отображается.
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
          <DialogFooter>
            <DialogClose
              render={
                <Button type="button" variant="outline">
                  Отмена
                </Button>
              }
            />
            <Button type="submit" disabled={pending}>
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : editing ? (
                'Сохранить'
              ) : (
                'Добавить'
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

export function ConfirmDialog({
  state,
  pending,
  onClose,
}: {
  state: {
    title: string
    description: string
    onConfirm: () => void
  } | null
  pending: boolean
  onClose: () => void
}) {
  return (
    <Dialog open={state != null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{state?.title}</DialogTitle>
          <DialogDescription>{state?.description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline">Отмена</Button>} />
          <Button
            variant="destructive"
            disabled={pending}
            onClick={() => state?.onConfirm()}
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : 'Удалить'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}


/*
 * Money-movement dialogs moved to finance-entry-dialogs.tsx; re-exported so
 * existing finance-admin.tsx imports keep working unchanged.
 */
export {
  EntryDialog,
  StatDialog,
  TopupDialog,
} from '@/components/admin/finance/finance-entry-dialogs'
