'use client'

import { useState, useTransition } from 'react'
import {
  Check,
  Copy,
  Download,
  KeyRound,
  Loader2,
  Phone,
  Plus,
  ShieldCheck,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  addWhatsappNumberAction,
  assignWhatsappNumberAction,
  checkWhatsappTokenAction,
  deleteWhatsappNumberAction,
  importWhatsappNumbersAction,
  saveWhatsappAppConfigAction,
} from '@/app/actions/whatsapp'
import { StatusBadge } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import type { Manager } from '@/lib/types'

const UNASSIGNED = 'unassigned'

interface WhatsappAppStatus {
  configured: boolean
  webhookReady: boolean
  hasAppSecret: boolean
  verifyToken: string | null
  wabaId: string | null
  tokenMask: string | null
}

interface WhatsappNumber {
  id: string
  managerId: string | null
  managerName: string | null
  name: string
  phoneNumberId: string
  displayPhoneNumber: string
  status: 'connected' | 'pending' | 'disconnected' | 'error'
  createdAt: string
}

interface ImportCandidate {
  phoneNumberId: string
  displayPhoneNumber: string
  verifiedName: string
}

export function WhatsappAdmin({
  status,
  numbers,
  managers,
  callbackUrl,
  baseUrlError,
}: {
  status: WhatsappAppStatus
  numbers: WhatsappNumber[]
  managers: Manager[]
  callbackUrl: string
  baseUrlError: string | null
}) {
  return (
    <div className="flex flex-col gap-6">
      <AppConfigCard
        status={status}
        callbackUrl={callbackUrl}
        baseUrlError={baseUrlError}
      />
      <NumbersCard
        status={status}
        numbers={numbers}
        managers={managers}
      />
    </div>
  )
}

/* --------------------------- App config card --------------------------- */

function AppConfigCard({
  status,
  callbackUrl,
  baseUrlError,
}: {
  status: WhatsappAppStatus
  callbackUrl: string
  baseUrlError: string | null
}) {
  const [accessToken, setAccessToken] = useState('')
  const [appSecret, setAppSecret] = useState('')
  const [wabaId, setWabaId] = useState(status.wabaId ?? '')
  const [pending, startTransition] = useTransition()
  const [checking, startCheck] = useTransition()
  const [checkResult, setCheckResult] = useState<{
    ok: boolean
    message: string
  } | null>(null)

  function checkToken() {
    setCheckResult(null)
    startCheck(async () => {
      const res = await checkWhatsappTokenAction()
      setCheckResult(res)
      if (res.ok) toast.success(res.message)
      else toast.error(res.message)
    })
  }

  function save() {
    if (!accessToken.trim() && !status.configured) {
      toast.error('Укажите токен доступа.')
      return
    }
    // When already configured, an empty token field means "keep current token".
    if (status.configured && !accessToken.trim()) {
      toast.error(
        'Введите токен ещё раз, чтобы сохранить (он хранится в зашифрованном виде).',
      )
      return
    }
    startTransition(async () => {
      const res = await saveWhatsappAppConfigAction({
        accessToken: accessToken.trim(),
        appSecret: appSecret.trim(),
        wabaId: wabaId.trim(),
      })
      if (res.ok) {
        toast.success(res.message)
        setAccessToken('')
        setAppSecret('')
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Card className="flex flex-col gap-5 p-5">
      <div className="flex items-center gap-2">
        <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
          <KeyRound className="size-4 text-muted-foreground" />
        </div>
        <div>
          <h2 className="font-medium">Приложение Meta Cloud API</h2>
          <p className="text-xs text-muted-foreground">
            Настраивается один раз. Эти данные общие для всех номеров.
          </p>
        </div>
        <span
          className={
            status.configured
              ? 'ml-auto inline-flex items-center gap-1.5 rounded-full border border-success/30 bg-success/5 px-2.5 py-1 text-xs text-success'
              : 'ml-auto inline-flex items-center gap-1.5 rounded-full border border-warning/30 bg-warning/5 px-2.5 py-1 text-xs text-warning'
          }
        >
          {status.configured ? 'Настроено' : 'Не настроено'}
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Label htmlFor="wa-token">
            Токен доступа
            {status.configured && status.tokenMask ? (
              <span className="ml-2 font-mono text-xs text-muted-foreground">
                (текущий: {status.tokenMask})
              </span>
            ) : null}
          </Label>
          <Input
            id="wa-token"
            value={accessToken}
            onChange={(e) => setAccessToken(e.target.value)}
            placeholder={
              status.configured
                ? 'Введите заново, чтобы заменить'
                : 'EAAG... постоянный токен системного пользователя'
            }
            className="font-mono text-sm"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="wa-secret">
            App Secret
            {status.hasAppSecret ? (
              <span className="ml-2 text-xs text-success">сохранён</span>
            ) : (
              <span className="ml-2 text-xs text-muted-foreground">
                необязательно
              </span>
            )}
          </Label>
          <Input
            id="wa-secret"
            value={appSecret}
            onChange={(e) => setAppSecret(e.target.value)}
            placeholder={
              status.hasAppSecret ? 'Введите заново, чтобы заменить' : 'App Secret'
            }
            className="font-mono text-sm"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="wa-waba">WhatsApp Business Account ID</Label>
          <Input
            id="wa-waba"
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
            placeholder="Нужен для импорта номеров"
            className="font-mono text-sm"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <Button onClick={save} disabled={pending} className="w-full sm:w-auto">
            {pending ? <Loader2 className="size-4 animate-spin" /> : null}
            Сохранить настройки
          </Button>
          {status.configured ? (
            <Button
              type="button"
              variant="outline"
              onClick={checkToken}
              disabled={checking}
              className="w-full sm:w-auto"
            >
              {checking ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ShieldCheck className="size-4" />
              )}
              Проверить токен
            </Button>
          ) : null}
        </div>
      </div>

      {checkResult ? (
        <div
          className={
            checkResult.ok
              ? 'flex items-start gap-2 rounded-md border border-success/30 bg-success/5 px-3 py-2 text-xs text-success'
              : 'flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive'
          }
          role="status"
          aria-live="polite"
        >
          {checkResult.ok ? (
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          ) : (
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          )}
          <span>{checkResult.message}</span>
        </div>
      ) : null}

      {/* Webhook details to paste into Meta */}
      <div className="rounded-lg border border-border bg-muted/30 p-4">
        <p className="mb-3 text-sm font-medium">Данные для вебхука в Meta</p>
        {baseUrlError ? (
          <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <span>{baseUrlError}</span>
          </div>
        ) : (
          <CopyRow label="URL обратного вызова" value={callbackUrl} />
        )}
        {status.verifyToken ? (
          <div className="mt-2">
            <CopyRow label="Подтверждение маркера" value={status.verifyToken} />
          </div>
        ) : (
          <p className="mt-2 text-xs text-muted-foreground">
            Обновите страницу — токен подтверждения генерируется автоматически.
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">
          Этот шаг можно выполнить сразу, не дожидаясь токена доступа. В Meta:
          WhatsApp → Конфигурация → Вебхуки. Вставьте оба значения, нажмите
          «Проверить и сохранить», затем подпишитесь на поле{' '}
          <code className="font-mono">messages</code>.
        </p>
      </div>
    </Card>
  )
}

function CopyRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false)
  function copy() {
    navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopied(true)
        toast.success('Скопировано')
        setTimeout(() => setCopied(false), 1500)
      })
      .catch(() => toast.error('Не удалось скопировать'))
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border border-border bg-background px-2.5 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button type="button" variant="outline" size="icon-sm" onClick={copy}>
          {copied ? (
            <Check className="size-4 text-success" />
          ) : (
            <Copy className="size-4" />
          )}
        </Button>
      </div>
    </div>
  )
}

/* ----------------------------- Numbers card ---------------------------- */

function NumbersCard({
  status,
  numbers,
  managers,
}: {
  status: WhatsappAppStatus
  numbers: WhatsappNumber[]
  managers: Manager[]
}) {
  const [pending, startTransition] = useTransition()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [candidates, setCandidates] = useState<ImportCandidate[]>([])

  function runImport() {
    startTransition(async () => {
      const res = await importWhatsappNumbersAction()
      if (res.ok) {
        toast.success(res.message)
        setCandidates(res.candidates ?? [])
      } else {
        toast.error(res.message)
      }
    })
  }

  function addCandidate(c: ImportCandidate) {
    setBusyId(c.phoneNumberId)
    startTransition(async () => {
      const res = await addWhatsappNumberAction({
        phoneNumberId: c.phoneNumberId,
        name: c.verifiedName || c.displayPhoneNumber,
        managerId: null,
      })
      if (res.ok) {
        toast.success(res.message)
        setCandidates((prev) =>
          prev.filter((x) => x.phoneNumberId !== c.phoneNumberId),
        )
      } else {
        toast.error(res.message)
      }
      setBusyId(null)
    })
  }

  function reassign(id: string, value: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await assignWhatsappNumberAction(
        id,
        value === UNASSIGNED ? null : value,
      )
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
      setBusyId(null)
    })
  }

  function remove(id: string) {
    setBusyId(id)
    startTransition(async () => {
      const res = await deleteWhatsappNumberAction(id)
      if (res.ok) {
        toast.success(res.message)
      } else {
        toast.error(res.message)
      }
      setBusyId(null)
    })
  }

  return (
    <Card className="flex flex-col gap-4 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <div className="flex size-9 items-center justify-center rounded-lg border border-border bg-muted/40">
            <Phone className="size-4 text-muted-foreground" />
          </div>
          <div>
            <h2 className="font-medium">Номера</h2>
            <p className="text-xs text-muted-foreground">
              Каждый номер закрепляется за одним менеджером.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={runImport}
            disabled={pending || !status.configured}
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Импорт из WABA
          </Button>
          <AddNumberDialog managers={managers} disabled={!status.configured} />
        </div>
      </div>

      {!status.configured ? (
        <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
          Сначала сохраните настройки приложения выше.
        </p>
      ) : null}

      {/* Import candidates */}
      {candidates.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-muted/20 p-3">
          <p className="text-xs font-medium text-muted-foreground">
            Найдены номера в WABA — нажмите, чтобы добавить:
          </p>
          {candidates.map((c) => (
            <div
              key={c.phoneNumberId}
              className="flex items-center justify-between gap-3 rounded-md border border-border bg-background px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {c.displayPhoneNumber}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {c.verifiedName || c.phoneNumberId}
                </p>
              </div>
              <Button
                size="sm"
                onClick={() => addCandidate(c)}
                disabled={pending && busyId === c.phoneNumberId}
              >
                {pending && busyId === c.phoneNumberId ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Plus className="size-4" />
                )}
                Добавить
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      {/* Numbers list */}
      {numbers.length === 0 ? (
        status.configured ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
            Номеров пока нет. Импортируйте из WABA или добавьте вручную.
          </p>
        ) : null
      ) : (
        <div className="flex flex-col gap-3">
          {numbers.map((n) => {
            const busy = pending && busyId === n.id
            return (
              <div
                key={n.id}
                className="flex flex-col gap-3 rounded-lg border border-border p-4 lg:flex-row lg:items-center lg:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-muted/40">
                    <Phone className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">
                      {n.displayPhoneNumber}
                    </p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      ID: {n.phoneNumberId}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <StatusBadge status={n.status} />
                  <Select
                    value={n.managerId ?? UNASSIGNED}
                    onValueChange={(v) => reassign(n.id, v ?? UNASSIGNED)}
                  >
                    <SelectTrigger
                      aria-label="Менеджер"
                      className="w-44"
                      disabled={busy}
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={UNASSIGNED}>Не назначен</SelectItem>
                      {managers.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    variant="outline"
                    size="icon-sm"
                    onClick={() => remove(n.id)}
                    disabled={busy}
                    aria-label="Удалить номер"
                  >
                    {busy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Trash2 className="size-4" />
                    )}
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

function AddNumberDialog({
  managers,
  disabled,
}: {
  managers: Manager[]
  disabled: boolean
}) {
  const [open, setOpen] = useState(false)
  const [assignTo, setAssignTo] = useState(UNASSIGNED)
  const [pending, startTransition] = useTransition()

  function submit(formData: FormData) {
    const phoneNumberId = String(formData.get('phoneNumberId') ?? '').trim()
    const name = String(formData.get('name') ?? '').trim()
    startTransition(async () => {
      const res = await addWhatsappNumberAction({
        phoneNumberId,
        name,
        managerId: assignTo === UNASSIGNED ? null : assignTo,
      })
      if (res.ok) {
        toast.success(res.message)
        setOpen(false)
        setAssignTo(UNASSIGNED)
      } else {
        toast.error(res.message)
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button disabled={disabled}>
            <Plus className="size-4" />
            Добавить вручную
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <form action={submit}>
          <DialogHeader>
            <DialogTitle>Добавить номер WhatsApp</DialogTitle>
            <DialogDescription>
              Укажите Phone Number ID из Meta. Номер проверяется через Graph API
              перед сохранением.
            </DialogDescription>
          </DialogHeader>
          <div className="my-4 flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="wa-add-id">Phone Number ID</Label>
              <Input
                id="wa-add-id"
                name="phoneNumberId"
                placeholder="1162878263578339"
                className="font-mono text-sm"
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="wa-add-name">Название</Label>
              <Input
                id="wa-add-name"
                name="name"
                placeholder="Необязательно — подставится из Meta"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Назначить менеджеру</Label>
              <Select
                value={assignTo}
                onValueChange={(v) => setAssignTo(v ?? UNASSIGNED)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={UNASSIGNED}>Без назначения</SelectItem>
                  {managers.map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Отмена
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Добавить
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
