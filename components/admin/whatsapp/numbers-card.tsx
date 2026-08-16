'use client'

import { useState, useTransition } from 'react'
import { Download, Loader2, Phone, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  addWhatsappNumberAction,
  assignWhatsappNumberAction,
  deleteWhatsappNumberAction,
  importWhatsappNumbersAction,
} from '@/app/actions/whatsapp'
import { StatusBadge } from '@/components/page-parts'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { Manager } from '@/lib/types'
import { AddNumberDialog } from './add-number-dialog'
import {
  UNASSIGNED,
  type ImportCandidate,
  type WhatsappAppStatus,
  type WhatsappNumber,
} from './types'

/** Number inventory: WABA import, manual add, per-number manager binding. */
export function NumbersCard({
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
