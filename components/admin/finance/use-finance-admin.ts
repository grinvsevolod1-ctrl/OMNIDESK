'use client'

/**
 * Всё клиентское состояние раздела «Финансы»: навигация дашборд/источник,
 * активная вкладка, состояние всех диалогов, обёртка run() для server actions
 * и производные выборки по активному источнику. Контейнер finance-admin.tsx
 * остаётся презентационным — паттерн тот же, что у ai-console/use-ai-console
 * и leads/use-leads-data.
 */

import { useMemo, useState, useTransition } from 'react'
import { toast } from 'sonner'
import type { FinanceResult } from '@/app/actions/finance'
import type {
  FinanceAdAccount,
  FinanceEntry,
  FinanceResource,
  FinanceSection,
  VaultItem,
} from '@/lib/finance-types'
import type { SubTab } from '@/components/admin/finance/finance-utils'

export type ResourceDialogState =
  | { mode: 'create' }
  | { mode: 'edit'; resource: FinanceResource }
  | null

export type AccountDialogState =
  | { mode: 'create'; resourceId: string }
  | { mode: 'edit'; account: FinanceAdAccount }
  | null

export type EntryDialogState =
  | { mode: 'create'; sectionId: string }
  | { mode: 'edit'; entry: FinanceEntry }
  | null

export type VaultDialogState =
  | { mode: 'create'; resourceId: string }
  | { mode: 'edit'; item: VaultItem }
  | null

export interface ConfirmState {
  title: string
  description: string
  onConfirm: () => void
}

export function useFinanceAdmin({
  resources,
  sections,
  entries,
  adAccounts,
  vaultItems,
  resourceLeads,
}: {
  resources: FinanceResource[]
  sections: FinanceSection[]
  entries: FinanceEntry[]
  adAccounts: FinanceAdAccount[]
  vaultItems: VaultItem[]
  resourceLeads?: Record<string, number>
}) {
  const [pending, startTransition] = useTransition()
  const [view, setView] = useState<'dashboard' | 'resource'>('dashboard')
  const [resourceId, setResourceId] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('overview')

  // Dialog state
  const [resourceDialog, setResourceDialog] =
    useState<ResourceDialogState>(null)
  const [accountDialog, setAccountDialog] = useState<AccountDialogState>(null)
  const [topupDialog, setTopupDialog] = useState<FinanceAdAccount | null>(null)
  const [statDialog, setStatDialog] = useState<FinanceAdAccount | null>(null)
  const [entryDialog, setEntryDialog] = useState<EntryDialogState>(null)
  const [vaultDialog, setVaultDialog] = useState<VaultDialogState>(null)
  const [confirm, setConfirm] = useState<ConfirmState | null>(null)

  /** Запуск server action с единым toast-флоу успех/ошибка. */
  function run(fn: () => Promise<FinanceResult>, onOk?: () => void) {
    startTransition(async () => {
      const res = await fn()
      if (res.ok) {
        toast.success(res.message)
        onOk?.()
      } else {
        toast.error(res.message)
      }
    })
  }

  const activeResource =
    resources.find((r) => r.id === resourceId) ?? resources[0] ?? null

  const resourceAccounts = useMemo(
    () =>
      activeResource
        ? adAccounts.filter((a) => a.resourceId === activeResource.id)
        : [],
    [adAccounts, activeResource],
  )
  const resourceSections = useMemo(
    () =>
      activeResource
        ? sections.filter((s) => s.resourceId === activeResource.id)
        : [],
    [sections, activeResource],
  )
  const resourceEntries = useMemo(
    () =>
      activeResource
        ? entries.filter((e) => e.resourceId === activeResource.id)
        : [],
    [entries, activeResource],
  )
  const resourceVaultItems = useMemo(
    () =>
      activeResource
        ? vaultItems.filter((v) => v.resourceId === activeResource.id)
        : [],
    [vaultItems, activeResource],
  )

  // Реальные лиды источника — из обращений по привязанным каналам (приходят с
  // сервера). Больше НЕ берём из статистики рекламных кабинетов: то число ни к
  // чему реальному не привязано и жило само по себе.
  const leadCountByResource = useMemo(() => {
    const map = new Map<string, number>()
    for (const [id, n] of Object.entries(resourceLeads ?? {})) {
      map.set(id, n)
    }
    return map
  }, [resourceLeads])

  return {
    pending,
    view,
    setView,
    setResourceId,
    subTab,
    setSubTab,
    resourceDialog,
    setResourceDialog,
    accountDialog,
    setAccountDialog,
    topupDialog,
    setTopupDialog,
    statDialog,
    setStatDialog,
    entryDialog,
    setEntryDialog,
    vaultDialog,
    setVaultDialog,
    confirm,
    setConfirm,
    run,
    activeResource,
    resourceAccounts,
    resourceSections,
    resourceEntries,
    resourceVaultItems,
    leadCountByResource,
  }
}
