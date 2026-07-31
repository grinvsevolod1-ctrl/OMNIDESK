'use client'

import { useMemo, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import {
  ArrowLeft,
  BarChart3,
  Pencil,
  Plus,
  TrendingDown,
  Vault,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  addAdStatAction,
  addAdTopupAction,
  createAdAccountAction,
  createEntryAction,
  createResourceAction,
  createVaultItemAction,
  importVaultItemsAction,
  deleteAdAccountAction,
  deleteAdStatAction,
  deleteAdTopupAction,
  deleteEntryAction,
  deleteResourceAction,
  deleteSectionAction,
  deleteVaultItemAction,
  syncAdAccountAction,
  toggleVaultFavoriteAction,
  updateAdAccountAction,
  updateEntryAction,
  updateResourceAction,
  updateVaultItemAction,
  type FinanceResult,
} from '@/app/actions/finance'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import {
  type UsdRates,
  type FinanceAdAccount,
  type FinanceEntry,
  type FinanceResource,
  type FinanceSection,
  type VaultItem,
} from '@/lib/finance-types'
import {
  RatesContext,
  formatInt,
  formatUsd,
  summarizeAds,
  type SubTab,
} from '@/components/admin/finance/finance-utils'
// The Vault lives behind its own tab and pulls a ~1k-line subtree (panel +
// editor dialog). Load it on demand so the default Finance view (overview/ads/
// expenses) doesn't ship the Vault code in its initial chunk.
const VaultPanel = dynamic(
  () => import('@/components/admin/finance/vault-panel').then((m) => m.VaultPanel),
  {
    loading: () => (
      <div className="p-6 text-sm text-muted-foreground">Загрузка сейфа…</div>
    ),
  },
)
const VaultDialog = dynamic(
  () =>
    import('@/components/admin/finance/vault-panel').then((m) => m.VaultDialog),
)
import {
  AdAccountDialog,
  ConfirmDialog,
  EntryDialog,
  ResourceDialog,
  StatDialog,
  TopupDialog,
} from '@/components/admin/finance/finance-dialogs'
import { ExpensesPanel } from '@/components/admin/finance/expenses-panel'
import { AdsPanel } from '@/components/admin/finance/ads-panel'
import { GlobalDashboard } from '@/components/admin/finance/global-dashboard'
import { OverviewPanel } from '@/components/admin/finance/overview-panel'

/* ================================================================== */
/* Meta, formatters and aggregation live in ./finance/finance-utils    */
/* (extracted so every panel shares one source of truth).              */
/* ================================================================== */

/* ================================================================== */
/* Source sub-tab card                                                 */
/* ================================================================== */

/**
 * Крупная масштабируемая «карта-вкладка» источника вместо сжатых чипов.
 * Иконка + название + живая метрика (лиды / кабинеты / расход / секреты).
 * Построена поверх shadcn TabsTrigger, поэтому переключение и доступность
 * работают штатно, а сетка в TabsList тянется на всю ширину.
 */
function SourceTabCard({
  value,
  active,
  icon: Icon,
  label,
  stat,
}: {
  value: string
  active: boolean
  icon: LucideIcon
  label: string
  stat: string
}) {
  return (
    <TabsTrigger
      value={value}
      className={cn(
        'flex h-auto flex-col items-start gap-2 rounded-xl border p-3 text-left transition-colors sm:p-4',
        'data-active:border-primary data-active:bg-primary/5 data-active:shadow-none',
        active
          ? 'border-primary bg-primary/5'
          : 'border-border bg-card hover:bg-muted/50',
      )}
    >
      <span
        className={cn(
          'flex size-9 items-center justify-center rounded-lg',
          active
            ? 'bg-primary text-primary-foreground'
            : 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="size-4.5" />
      </span>
      <span className="flex flex-col">
        <span
          className={cn(
            'text-sm font-semibold',
            active ? 'text-foreground' : 'text-foreground/90',
          )}
        >
          {label}
        </span>
        <span className="text-xs tabular-nums text-muted-foreground">
          {stat}
        </span>
      </span>
    </TabsTrigger>
  )
}

/* ================================================================== */
/* Main                                                                */
/* ================================================================== */

export function FinanceAdmin({
  resources,
  sections,
  entries,
  adAccounts,
  vaultItems,
  encryptionReady,
  rates,
  resourceLeads,
}: {
  resources: FinanceResource[]
  sections: FinanceSection[]
  entries: FinanceEntry[]
  adAccounts: FinanceAdAccount[]
  vaultItems: VaultItem[]
  encryptionReady: boolean
  rates: UsdRates
  /**
   * Реальные лиды по источнику: distinct входящих обращений из привязанных
   * каналов (resourceId → число). Это заменяет фейковые «лиды» из статистики
   * кабинетов. Рекламные лиды/CPL остаются отдельно во вкладке «Реклама».
   */
  resourceLeads?: Record<string, number>
}) {
  const [pending, startTransition] = useTransition()
  const [view, setView] = useState<'dashboard' | 'resource'>('dashboard')
  const [resourceId, setResourceId] = useState<string | null>(null)
  const [subTab, setSubTab] = useState<SubTab>('overview')

  // Dialog state
  const [resourceDialog, setResourceDialog] = useState<
    { mode: 'create' } | { mode: 'edit'; resource: FinanceResource } | null
  >(null)
  const [accountDialog, setAccountDialog] = useState<
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; account: FinanceAdAccount }
    | null
  >(null)
  const [topupDialog, setTopupDialog] = useState<FinanceAdAccount | null>(null)
  const [statDialog, setStatDialog] = useState<FinanceAdAccount | null>(null)
  const [entryDialog, setEntryDialog] = useState<
    | { mode: 'create'; sectionId: string }
    | { mode: 'edit'; entry: FinanceEntry }
    | null
  >(null)
  const [vaultDialog, setVaultDialog] = useState<
    | { mode: 'create'; resourceId: string }
    | { mode: 'edit'; item: VaultItem }
    | null
  >(null)
  const [confirm, setConfirm] = useState<{
    title: string
    description: string
    onConfirm: () => void
  } | null>(null)

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

  /* ---------------- Back bar (resource view only) ---------------- */

  const backBar = (
    <button
      type="button"
      onClick={() => setView('dashboard')}
      className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <ArrowLeft className="size-4" />
      Назад к учёту
    </button>
  )

  /* ---------------- Empty (no resources) ---------------- */

  if (!activeResource) {
    return (
      <RatesContext.Provider value={rates}>
        <div className="flex flex-col gap-4">
          <EmptyState
            icon={Wallet}
            title="Пока нет источников лидов"
            description="Добавьте первый источник (например, site.com), чтобы вести рекламные кабинеты и расходы."
            action={
              <Button
                className="gap-1.5"
                onClick={() => setResourceDialog({ mode: 'create' })}
              >
                <Plus className="size-4" /> Новый источник лидов
              </Button>
            }
          />
          <ResourceDialog
            state={resourceDialog}
            pending={pending}
            onClose={() => setResourceDialog(null)}
            onSubmit={(fd) =>
              run(() => createResourceAction(fd), () => setResourceDialog(null))
            }
            onUpdate={() => {}}
            onDelete={() => {}}
          />
        </div>
      </RatesContext.Provider>
    )
  }

  if (view === 'dashboard') {
    return (
      <RatesContext.Provider value={rates}>
        <div className="flex flex-col gap-5">
          <GlobalDashboard
            resources={resources}
            adAccounts={adAccounts}
            entries={entries}
            vaultItems={vaultItems}
            leadCountByResource={leadCountByResource}
            onOpenResource={(id, tab) => {
              setResourceId(id)
              setSubTab(tab ?? 'overview')
              setView('resource')
            }}
            onCreateResource={() => setResourceDialog({ mode: 'create' })}
          />
          <ResourceDialog
            state={resourceDialog}
            pending={pending}
            onClose={() => setResourceDialog(null)}
            onSubmit={(fd) =>
              run(() => createResourceAction(fd), () => setResourceDialog(null))
            }
            onUpdate={() => {}}
            onDelete={() => {}}
          />
        </div>
      </RatesContext.Provider>
    )
  }

  const adSummary = summarizeAds(resourceAccounts, rates)

  // Сумма расходов источника в USD — для подписи на вкладке «Расходы».
  // Записи уже хранятся в USD (origAmount переводится при вводе); в этом UI все
  // записи — расходы, поэтому суммируем amount по всем.
  const resourceExpenseTotal = resourceEntries.reduce(
    (s, e) => s + e.amount,
    0,
  )

  return (
    <RatesContext.Provider value={rates}>
    <div className="flex flex-col gap-5">
      {backBar}

      {/* Resource header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold tracking-tight">
            {activeResource.name}
          </h2>
          {activeResource.archived ? (
            <Badge className="bg-muted text-muted-foreground" variant="outline">
              В архиве
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() =>
              setResourceDialog({ mode: 'edit', resource: activeResource })
            }
          >
            <Pencil className="size-4" /> Источник
          </Button>
        </div>
      </div>

      {activeResource.description ? (
        <p className="-mt-2 text-sm text-muted-foreground">
          {activeResource.description}
        </p>
      ) : null}

      <Tabs
        value={subTab}
        onValueChange={(v) => setSubTab(v as SubTab)}
        className="flex-col"
      >
        <TabsList className="grid !h-auto w-full grid-cols-2 gap-2 bg-transparent p-0 sm:grid-cols-4">
          <SourceTabCard
            value="overview"
            active={subTab === 'overview'}
            icon={BarChart3}
            label="Обзор"
            stat={`${formatInt(leadCountByResource.get(activeResource.id) ?? 0)} лид.`}
          />
          <SourceTabCard
            value="ads"
            active={subTab === 'ads'}
            icon={Wallet}
            label="Реклама"
            stat={`${adSummary.activeAccounts}/${adSummary.totalAccounts} кабин.`}
          />
          <SourceTabCard
            value="expenses"
            active={subTab === 'expenses'}
            icon={TrendingDown}
            label="Расходы"
            stat={formatUsd(resourceExpenseTotal)}
          />
          <SourceTabCard
            value="vault"
            active={subTab === 'vault'}
            icon={Vault}
            label="Хранилище"
            stat={
              resourceVaultItems.length > 0
                ? `${formatInt(resourceVaultItems.length)} секр.`
                : 'пусто'
            }
          />
        </TabsList>

        {/* ---------------- Overview ---------------- */}
        <TabsContent value="overview" className="mt-4">
          <OverviewPanel
            summary={adSummary}
            accounts={resourceAccounts}
            entries={resourceEntries}
            resource={activeResource}
            onGoAds={() => setSubTab('ads')}
            onGoExpenses={() => setSubTab('expenses')}
          />
        </TabsContent>

        {/* ---------------- Ads ---------------- */}
        <TabsContent value="ads" className="mt-4">
          <AdsPanel
            accounts={resourceAccounts}
            pending={pending}
            onAdd={() =>
              setAccountDialog({ mode: 'create', resourceId: activeResource.id })
            }
            onEdit={(account) => setAccountDialog({ mode: 'edit', account })}
            onTopup={(account) => setTopupDialog(account)}
            onStat={(account) => setStatDialog(account)}
            onSync={(account) => run(() => syncAdAccountAction(account.id))}
            onDeleteAccount={(account) =>
              setConfirm({
                title: 'Удалить кабинет?',
                description: `«${account.name}» и вся история пополнений и статистики будут удалены безвозвратно.`,
                onConfirm: () =>
                  run(() => deleteAdAccountAction(account.id), () =>
                    setConfirm(null),
                  ),
              })
            }
            onDeleteTopup={(id) =>
              run(() => deleteAdTopupAction(id))
            }
            onDeleteStat={(id) => run(() => deleteAdStatAction(id))}
          />
        </TabsContent>

        {/* ---------------- Expenses ---------------- */}
        <TabsContent value="expenses" className="mt-4">
          <ExpensesPanel
            resource={activeResource}
            sections={resourceSections}
            entries={resourceEntries}
            pending={pending}
            run={run}
            onAddEntry={(sectionId) =>
              setEntryDialog({ mode: 'create', sectionId })
            }
            onEditEntry={(entry) => setEntryDialog({ mode: 'edit', entry })}
            onDeleteEntry={(entry) =>
              setConfirm({
                title: 'Удалить расход?',
                description: `«${entry.title}» и его чек-лист будут удалены.`,
                onConfirm: () =>
                  run(() => deleteEntryAction(entry.id), () =>
                    setConfirm(null),
                  ),
              })
            }
            onDeleteSection={(section) =>
              setConfirm({
                title: 'Удалить вкладку?',
                description: `«${section.name}» и все записи внутри будут удалены.`,
                onConfirm: () =>
                  run(() => deleteSectionAction(section.id), () =>
                    setConfirm(null),
                  ),
              })
            }
          />
        </TabsContent>

        {/* ---------------- Vault ---------------- */}
        <TabsContent value="vault" className="mt-4">
          <VaultPanel
            items={resourceVaultItems}
            encryptionReady={encryptionReady}
            pending={pending}
            resourceName={activeResource.name}
            onImport={(rows) =>
              run(() => importVaultItemsAction(activeResource.id, rows))
            }
            onAdd={() =>
              setVaultDialog({ mode: 'create', resourceId: activeResource.id })
            }
            onEdit={(item) => setVaultDialog({ mode: 'edit', item })}
            onToggleFavorite={(item) =>
              run(() => toggleVaultFavoriteAction(item.id, !item.favorite))
            }
            onDelete={(item) =>
              setConfirm({
                title: 'Удалить запись?',
                description: `«${item.title}» и все её секреты будут удалены безвозвратно.`,
                onConfirm: () =>
                  run(() => deleteVaultItemAction(item.id), () =>
                    setConfirm(null),
                  ),
              })
            }
          />
        </TabsContent>
      </Tabs>

      {/* Delete resource lives in the resource dialog */}

      {/* ---------------- Dialogs ---------------- */}
      <ResourceDialog
        state={resourceDialog}
        pending={pending}
        onClose={() => setResourceDialog(null)}
        onSubmit={(fd) =>
          run(() => createResourceAction(fd), () => setResourceDialog(null))
        }
        onUpdate={(id, fd) =>
          run(() => updateResourceAction(id, fd), () => setResourceDialog(null))
        }
        onDelete={(resource) =>
          setConfirm({
            title: 'Удалить ресурс?',
            description: `«${resource.name}» со всеми кабинетами, вкладками и записями будет удалён безвозвратно.`,
            onConfirm: () =>
              run(() => deleteResourceAction(resource.id), () => {
                setConfirm(null)
                setResourceDialog(null)
                setResourceId(null)
              }),
          })
        }
      />

      <AdAccountDialog
        state={accountDialog}
        pending={pending}
        onClose={() => setAccountDialog(null)}
        onCreate={(rid, fd) =>
          run(() => createAdAccountAction(rid, fd), () =>
            setAccountDialog(null),
          )
        }
        onUpdate={(id, fd) =>
          run(() => updateAdAccountAction(id, fd), () => setAccountDialog(null))
        }
      />

      <TopupDialog
        account={topupDialog}
        pending={pending}
        onClose={() => setTopupDialog(null)}
        onSubmit={(id, fd) =>
          run(() => addAdTopupAction(id, fd), () => setTopupDialog(null))
        }
      />

      <StatDialog
        account={statDialog}
        pending={pending}
        onClose={() => setStatDialog(null)}
        onSubmit={(id, fd) =>
          run(() => addAdStatAction(id, fd), () => setStatDialog(null))
        }
      />

      <EntryDialog
        state={entryDialog}
        pending={pending}
        onClose={() => setEntryDialog(null)}
        onCreate={(sid, fd) =>
          run(() => createEntryAction(sid, fd), () => setEntryDialog(null))
        }
        onUpdate={(id, fd) =>
          run(() => updateEntryAction(id, fd), () => setEntryDialog(null))
        }
      />

      <VaultDialog
        state={vaultDialog}
        pending={pending}
        encryptionReady={encryptionReady}
        onClose={() => setVaultDialog(null)}
        onCreate={(rid, fd) =>
          run(() => createVaultItemAction(rid, fd), () => setVaultDialog(null))
        }
        onUpdate={(id, fd) =>
          run(() => updateVaultItemAction(id, fd), () => setVaultDialog(null))
        }
      />

      <ConfirmDialog
        state={confirm}
        pending={pending}
        onClose={() => setConfirm(null)}
      />
    </div>
    </RatesContext.Provider>
  )
}
