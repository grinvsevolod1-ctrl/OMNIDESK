'use client'

import { useEffect, useState, useTransition } from 'react'
import { toast } from 'sonner'
import {
  Loader2,
  Plus,
  Play,
  Square,
  Trash2,
  ShieldAlert,
  ShieldCheck,
  Flame,
  UserRound,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  listOutreachAccountsAction,
  listOutreachManagersAction,
  outreachAssignAction,
  outreachDeleteAction,
  outreachStartAction,
  outreachStopAction,
  type OutreachManagerOption,
} from '@/app/actions/admin-secret/outreach-accounts'
import type { OutreachAccount } from '@/lib/data/outreach-accounts'
import { OutreachConnectDialog } from './outreach-connect-dialog'
import { cn } from '@/lib/utils'

const UNASSIGNED = '__none__'

export function AccountsPanel() {
  const [accounts, setAccounts] = useState<OutreachAccount[]>([])
  const [managers, setManagers] = useState<OutreachManagerOption[]>([])
  const [loading, setLoading] = useState(true)
  const [connectOpen, setConnectOpen] = useState(false)
  const [pending, startTransition] = useTransition()

  function reload() {
    listOutreachAccountsAction()
      .then(setAccounts)
      .catch(() => toast.error('Не удалось загрузить аккаунты'))
  }

  useEffect(() => {
    let cancelled = false
    Promise.all([listOutreachAccountsAction(), listOutreachManagersAction()])
      .then(([accs, mgrs]) => {
        if (cancelled) return
        setAccounts(accs)
        setManagers(mgrs)
      })
      .catch(() => toast.error('Не удалось загрузить данные'))
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  function assign(id: string, managerId: string) {
    startTransition(async () => {
      try {
        const next = await outreachAssignAction(
          id,
          managerId === UNASSIGNED ? null : managerId,
        )
        setAccounts(next)
      } catch {
        toast.error('Ошибка назначения')
      }
    })
  }

  function toggleRun(a: OutreachAccount) {
    startTransition(async () => {
      try {
        const online = a.sessionStatus === 'online'
        const next = online
          ? await outreachStopAction(a.id)
          : await outreachStartAction(a.id)
        setAccounts(next)
      } catch {
        toast.error('Ошибка')
      }
    })
  }

  function remove(a: OutreachAccount) {
    startTransition(async () => {
      try {
        const next = await outreachDeleteAction(a.id)
        setAccounts(next)
        toast.success('Аккаунт удалён')
      } catch {
        toast.error('Ошибка удаления')
      }
    })
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Пул боевых аккаунтов</p>
          <p className="text-sm text-muted-foreground">
            Прогрев, спам-статус и назначение менеджеру — в одном месте.
          </p>
        </div>
        <Button onClick={() => setConnectOpen(true)} className="gap-1.5">
          <Plus className="size-4" />
          Подключить аккаунт
        </Button>
      </div>

      {loading ? (
        <div className="flex justify-center py-12 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : accounts.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Пул пуст. Подключите первый аккаунт, чтобы начать прогрев.
          </p>
        </div>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          {accounts.map((a) => (
            <AccountCard
              key={a.id}
              account={a}
              managers={managers}
              pending={pending}
              onAssign={assign}
              onToggleRun={toggleRun}
              onRemove={remove}
            />
          ))}
        </div>
      )}

      <OutreachConnectDialog
        open={connectOpen}
        onOpenChange={setConnectOpen}
        onConnected={reload}
      />
    </div>
  )
}

function AccountCard({
  account: a,
  managers,
  pending,
  onAssign,
  onToggleRun,
  onRemove,
}: {
  account: OutreachAccount
  managers: OutreachManagerOption[]
  pending: boolean
  onAssign: (id: string, managerId: string) => void
  onToggleRun: (a: OutreachAccount) => void
  onRemove: (a: OutreachAccount) => void
}) {
  const online = a.sessionStatus === 'online'
  const spamBlocked =
    a.spamblockStatus === 'blocked' || a.spamblockStatus === 'limited'

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card/40 p-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            'flex size-10 items-center justify-center rounded-lg border',
            online
              ? 'border-primary/40 bg-primary/10 text-primary'
              : 'border-border bg-muted/40 text-muted-foreground',
          )}
        >
          <UserRound className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">
            {a.label || a.phone || 'Аккаунт'}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {a.apiKeyLabel ? `ключ: ${a.apiKeyLabel}` : 'без ключа'}
            {a.phone ? ` · ${a.phone}` : ''}
          </p>
        </div>
        <Badge variant={online ? 'default' : 'secondary'}>
          {online ? 'в сети' : 'офлайн'}
        </Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Badge
          variant="outline"
          className={cn(
            'gap-1',
            spamBlocked
              ? 'border-destructive/40 text-destructive'
              : 'border-primary/30 text-primary',
          )}
        >
          {spamBlocked ? (
            <ShieldAlert className="size-3" />
          ) : (
            <ShieldCheck className="size-3" />
          )}
          {spamBlocked ? 'спам-блок' : 'чистый'}
        </Badge>
        <Badge variant="outline" className="gap-1">
          <Flame className="size-3" />
          {warmupLabel(a.warmupStage)}
        </Badge>
        <Badge variant="outline">день {a.warmupDay}</Badge>
        <Badge variant="outline">сегодня: {a.dailySent}</Badge>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={a.assignedManagerId ?? UNASSIGNED}
          onValueChange={(v) => onAssign(a.id, v ?? UNASSIGNED)}
          disabled={pending}
        >
          <SelectTrigger className="h-9 flex-1">
            <SelectValue placeholder="Назначить менеджеру" />
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
          variant="outline"
          size="sm"
          onClick={() => onToggleRun(a)}
          disabled={pending}
          className="gap-1.5"
        >
          {online ? (
            <>
              <Square className="size-3.5" /> Стоп
            </>
          ) : (
            <>
              <Play className="size-3.5" /> Пуск
            </>
          )}
        </Button>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRemove(a)}
          disabled={pending}
          title="Удалить аккаунт"
        >
          <Trash2 className="size-4 text-destructive" />
        </Button>
      </div>
    </div>
  )
}

function warmupLabel(stage: string): string {
  switch (stage) {
    case 'cold':
      return 'холодный'
    case 'warming':
      return 'прогрев'
    case 'ready':
      return 'боевой'
    default:
      return stage || 'новый'
  }
}
