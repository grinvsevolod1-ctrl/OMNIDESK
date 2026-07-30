'use client'

import { useMemo, useState, useTransition } from 'react'
import dynamic from 'next/dynamic'
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  Archive,
  AlertTriangle,
  BarChart3,
  Table2,
  Check,
  ChevronDown,
  ChevronRight,
  CreditCard,
  FolderPlus,
  Layers,
  Link as LinkIcon,
  ListChecks,
  Loader2,
  MousePointerClick,
  Pencil,
  Plus,
  RefreshCw,
  Target,
  Trash2,
  TrendingDown,
  Users,
  Vault,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  addAdStatAction,
  addAdTopupAction,
  addTaskAction,
  createAdAccountAction,
  createEntryAction,
  createResourceAction,
  createSectionAction,
  createVaultItemAction,
  importVaultItemsAction,
  deleteAdAccountAction,
  deleteAdStatAction,
  deleteAdTopupAction,
  deleteEntryAction,
  deleteResourceAction,
  deleteSectionAction,
  deleteTaskAction,
  deleteVaultItemAction,
  renameSectionAction,
  syncAdAccountAction,
  toggleTaskAction,
  toggleVaultFavoriteAction,
  updateAdAccountAction,
  updateEntryAction,
  updateResourceAction,
  updateVaultItemAction,
  type FinanceResult,
} from '@/app/actions/finance'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogClose,
  DialogContent,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
// Recharts is heavy (~100kb+); load the ads trend chart only when its tab is
// actually rendered, keeping it out of the initial finance-admin bundle.
// ssr:false because the chart measures its container and has no useful SSR HTML.
const AdsTrendChart = dynamic(
  () => import('./finance-charts').then((m) => m.AdsTrendChart),
  {
    ssr: false,
    loading: () => (
      <div className="h-64 animate-pulse rounded-lg bg-muted/40" />
    ),
  },
)
import { EmptyState, StatCard } from '@/components/page-parts'
import { cn } from '@/lib/utils'
import {
  FINANCE_ENTRY_STATUSES,
  toUsd,
  type UsdRates,
  type AdStatus,
  type FinanceAdAccount,
  type FinanceCurrency,
  type FinanceEntry,
  type FinanceEntryStatus,
  type FinanceResource,
  type FinanceSection,
  type VaultItem,
} from '@/lib/finance-types'
import {
  AD_STATUS_META,
  PLATFORM_META,
  RatesContext,
  STATUS_META,
  accountMetrics,
  formatDate,
  formatDateTime,
  formatInt,
  formatMoney,
  formatPct,
  formatUsd,
  summarizeAds,
  useRates,
  type ResourceAdSummary,
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
/* Table controls types                                                */
/* ================================================================== */

type SortField = 'date' | 'title' | 'amount' | 'status'
type SortDir = 'asc' | 'desc'
type StatusFilter = 'all' | FinanceEntryStatus
type SubTab = 'overview' | 'ads' | 'expenses' | 'vault'

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

/* ================================================================== */
/* Global dashboard (all resources)                                    */
/* ================================================================== */

interface CabinetCard {
  account: FinanceAdAccount
  resourceId: string
  resourceName: string
  balance: number
  topups: number
  spend: number
  leads: number
  blocked: boolean
}

interface SourceRow {
  resource: FinanceResource
  leads: number
  balance: number
  activeAccounts: number
  totalAccounts: number
}

/** Статусы, при которых кабинет считаем заблокированным/проблемным. */
const BLOCKED_AD_STATUSES = new Set<AdStatus>(['banned', 'no_funds'])

function GlobalDashboard({
  resources,
  adAccounts,
  leadCountByResource,
  onOpenResource,
  onCreateResource,
}: {
  resources: FinanceResource[]
  adAccounts: FinanceAdAccount[]
  entries: FinanceEntry[]
  vaultItems: VaultItem[]
  leadCountByResource: Map<string, number>
  onOpenResource: (id: string, tab?: SubTab) => void
  onCreateResource: () => void
}) {
  const rates = useRates()

  const { cabinets, sources } = useMemo(() => {
    const nameById = new Map(resources.map((r) => [r.id, r.name]))
    const cabinets: CabinetCard[] = []
    const sourceAgg = new Map<string, { balance: number; active: number; total: number }>()

    for (const a of adAccounts) {
      if (a.status === 'archived') continue
      const m = accountMetrics(a, rates)
      cabinets.push({
        account: a,
        resourceId: a.resourceId,
        resourceName: nameById.get(a.resourceId) ?? '—',
        balance: m.balance,
        topups: m.topups,
        spend: m.spend,
        leads: m.leads,
        blocked: BLOCKED_AD_STATUSES.has(a.status),
      })
      const agg = sourceAgg.get(a.resourceId) ?? { balance: 0, active: 0, total: 0 }
      agg.balance += m.balance
      agg.total += 1
      if (a.status === 'active') agg.active += 1
      sourceAgg.set(a.resourceId, agg)
    }

    // Проблемные кабинеты — вперёд, затем по возрастанию баланса.
    cabinets.sort((a, b) => {
      if (a.blocked !== b.blocked) return a.blocked ? -1 : 1
      return a.balance - b.balance
    })

    const sources: SourceRow[] = resources.map((resource) => {
      const agg = sourceAgg.get(resource.id)
      return {
        resource,
        leads: leadCountByResource.get(resource.id) ?? 0,
        balance: agg?.balance ?? 0,
        activeAccounts: agg?.active ?? 0,
        totalAccounts: agg?.total ?? 0,
      }
    })
    sources.sort((a, b) => b.leads - a.leads)

    return { cabinets, sources }
  }, [resources, adAccounts, rates, leadCountByResource])

  return (
    <div className="flex flex-col gap-6">
      {/* Балансы подключённых кабинетов */}
      <section className="space-y-3">
        <div className="flex items-center gap-2">
          <Wallet className="size-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold">Балансы подключённых кабинетов</h3>
          <span className="text-xs text-muted-foreground">· в USD</span>
        </div>
        {cabinets.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Пока нет подключённых кабинетов. Откройте источник лидов и добавьте
            рекламный кабинет.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {cabinets.map((c) => {
              const meta = AD_STATUS_META[c.account.status]
              return (
                <button
                  key={c.account.id}
                  type="button"
                  onClick={() => onOpenResource(c.resourceId, 'ads')}
                  className={cn(
                    'group flex flex-col gap-3 rounded-xl border p-4 text-left transition-colors',
                    c.blocked
                      ? 'border-destructive/50 bg-destructive/5 hover:bg-destructive/10'
                      : 'border-border bg-card hover:bg-muted/50',
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{c.account.name}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {c.resourceName}
                      </p>
                    </div>
                    <span
                      className={cn(
                        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium',
                        meta.className,
                      )}
                    >
                      <span className={cn('size-1.5 rounded-full', meta.dot)} />
                      {meta.label}
                    </span>
                  </div>
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Баланс
                    </p>
                    <p
                      className={cn(
                        'text-2xl font-semibold tabular-nums',
                        c.balance <= 0 ? 'text-destructive' : 'text-foreground',
                      )}
                    >
                      {formatUsd(c.balance)}
                    </p>
                  </div>
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Пополнено {formatUsd(c.topups)}</span>
                    <span className="inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
                      Подробнее <ArrowRight className="size-3.5" />
                    </span>
                  </div>
                </button>
              )
            })}
          </div>
        )}
      </section>

      {/* Источники лидов */}
      <section className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Layers className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Источники лидов</h3>
          </div>
          <Button size="sm" className="gap-1.5" onClick={onCreateResource}>
            <Plus className="size-4" /> Новый источник лидов
          </Button>
        </div>
        {sources.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Пока нет источников лидов.
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {sources.map((s) => (
              <button
                key={s.resource.id}
                type="button"
                onClick={() => onOpenResource(s.resource.id)}
                className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{s.resource.name}</span>
                  {s.resource.archived ? (
                    <Archive className="size-3.5 shrink-0 text-muted-foreground" />
                  ) : null}
                </div>
                <div className="flex items-end justify-between gap-2">
                  <div>
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Лиды
                    </p>
                    <p className="text-xl font-semibold tabular-nums">
                      {formatInt(s.leads)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      Баланс
                    </p>
                    <p
                      className={cn(
                        'text-sm font-semibold tabular-nums',
                        s.totalAccounts > 0 && s.balance <= 0
                          ? 'text-destructive'
                          : 'text-foreground',
                      )}
                    >
                      {s.totalAccounts > 0 ? formatUsd(s.balance) : '—'}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">
                  Кабинетов: {s.activeAccounts}/{s.totalAccounts}
                </p>
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

/* ================================================================== */
/* Overview panel                                                      */
/* ================================================================== */

function OverviewPanel({
  summary,
  accounts,
  entries,
  onGoAds,
  onGoExpenses,
}: {
  summary: ResourceAdSummary
  accounts: FinanceAdAccount[]
  entries: FinanceEntry[]
  resource: FinanceResource
  onGoAds: () => void
  onGoExpenses: () => void
}) {
  const rates = useRates()
  const expenseTotal = entries
    .filter((e) => e.status !== 'cancelled')
    .reduce((s, e) => s + e.amount, 0)
  const unpaid = entries.filter(
    (e) => e.status === 'planned' || e.status === 'in_progress',
  ).length

  return (
    <div className="flex flex-col gap-5">
      {summary.lowBalance.length > 0 ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-4">
          <TrendingDown className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">
              Заканчивается баланс: {summary.lowBalance.length}
            </p>
            <p className="text-muted-foreground">
              {summary.lowBalance.map((a) => a.name).join(', ')} — пополните
              баланс, чтобы реклама не остановилась.
            </p>
          </div>
        </Card>
      ) : null}

      {/* KPI row (unit-less metrics — safe to sum across currencies) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Лиды"
          value={formatInt(summary.leads)}
          icon={Users}
          hint="Из статистики кабинетов"
        />
        <StatCard
          label="Клики"
          value={formatInt(summary.clicks)}
          icon={MousePointerClick}
          hint={`CTR ${formatPct(summary.ctr)}`}
        />
        <StatCard
          label="Конверсия в лид"
          value={formatPct(summary.cr)}
          icon={Target}
          hint={`${formatInt(summary.impressions)} показов`}
        />
        <StatCard
          label="Кабинеты"
          value={`${summary.activeAccounts}/${summary.totalAccounts}`}
          icon={Wallet}
          hint="Активные / всего"
        />
      </div>

      {/* Balance (USD) */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Баланс рекламы</h3>
          <Button variant="ghost" size="sm" onClick={onGoAds}>
            Кабинеты <ChevronRight className="size-4" />
          </Button>
        </div>
        {summary.totalAccounts === 0 ? (
          <Card className="p-6 text-center text-sm text-muted-foreground">
            Ещё нет рекламных кабинетов.
          </Card>
        ) : (
          (() => {
            const t = summary.totals
            const cpl = t.leads > 0 ? t.spend / t.leads : null
            const low = t.balance <= 0
            return (
              <Card className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Общий баланс
                  </span>
                  <Wallet className="size-4 text-muted-foreground" />
                </div>
                <div
                  className={cn(
                    'mt-2 text-2xl font-semibold tabular-nums',
                    low ? 'text-destructive' : 'text-foreground',
                  )}
                >
                  {formatUsd(t.balance)}
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground sm:grid-cols-4">
                  <Metric label="Пополнено" value={formatUsd(t.topups)} />
                  <Metric label="Расход" value={formatUsd(t.spend)} />
                  <Metric label="Лиды" value={formatInt(t.leads)} />
                  <Metric
                    label="CPL"
                    value={cpl == null ? '—' : formatUsd(cpl)}
                  />
                </div>
              </Card>
            )
          })()
        )}
      </div>

      {/* Accounts quick list */}
      {accounts.length > 0 ? (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">Кабинеты</h3>
          <Card className="divide-y divide-border p-0">
            {accounts.map((a) => {
              const m = accountMetrics(a, rates)
              return (
                <div
                  key={a.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3"
                >
                  <div className="flex min-w-[160px] flex-1 items-center gap-2">
                    <span
                      className={cn(
                        'size-2 rounded-full',
                        AD_STATUS_META[a.status].dot,
                      )}
                    />
                    <span className="truncate font-medium">{a.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {PLATFORM_META[a.platform]}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm">
                    <span className="text-muted-foreground">Баланс: </span>
                    <span
                      className={cn(
                        'font-semibold',
                        m.balance <= 0 && 'text-destructive',
                      )}
                    >
                      {formatUsd(m.balance)}
                    </span>
                  </div>
                  <div className="tabular-nums text-sm text-muted-foreground">
                    {formatInt(m.leads)} лид. ·{' '}
                    {m.cpl === Number.POSITIVE_INFINITY
                      ? 'CPL —'
                      : `CPL ${formatUsd(m.cpl)}`}
                  </div>
                </div>
              )
            })}
          </Card>
        </div>
      ) : null}

      {/* Expenses summary */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Прочие расходы</h3>
          <Button variant="ghost" size="sm" onClick={onGoExpenses}>
            Открыть <ChevronRight className="size-4" />
          </Button>
        </div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <StatCard
            label="Всего расходов"
            value={formatUsd(expenseTotal)}
            icon={TrendingDown}
            hint={`${entries.length} записей`}
          />
          <StatCard
            label="Не оплачено"
            value={formatInt(unpaid)}
            icon={CreditCard}
            hint="Запланировано / в работе"
          />
        </div>
      </div>
    </div>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[11px] uppercase tracking-wide">{label}</span>
      <span className="font-medium tabular-nums text-foreground">{value}</span>
    </div>
  )
}

/* ================================================================== */
/* Ads panel                                                           */
/* ================================================================== */

function AdsPanel({
  accounts,
  pending,
  onAdd,
  onEdit,
  onTopup,
  onStat,
  onSync,
  onDeleteAccount,
  onDeleteTopup,
  onDeleteStat,
}: {
  accounts: FinanceAdAccount[]
  pending: boolean
  onAdd: () => void
  onEdit: (a: FinanceAdAccount) => void
  onTopup: (a: FinanceAdAccount) => void
  onStat: (a: FinanceAdAccount) => void
  onSync: (a: FinanceAdAccount) => void
  onDeleteAccount: (a: FinanceAdAccount) => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  const [layout, setLayout] = useState<'cards' | 'table'>('cards')
  const rates = useRates()

  const lowBalance = accounts.filter(
    (a) =>
      a.status !== 'archived' &&
      accountMetrics(a, rates).balance <= 0 &&
      accountMetrics(a, rates).topups > 0,
  )
  const hasStats = accounts.some((a) => a.stats.length > 0)

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">
          {accounts.length} кабинет(ов)
        </p>
        <div className="flex items-center gap-2">
          {accounts.length > 0 ? (
            <div className="inline-flex rounded-lg border border-border p-0.5">
              <button
                type="button"
                onClick={() => setLayout('cards')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                  layout === 'cards'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Layers className="size-4" /> Карточки
              </button>
              <button
                type="button"
                onClick={() => setLayout('table')}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                  layout === 'table'
                    ? 'bg-muted text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Table2 className="size-4" /> Таблица
              </button>
            </div>
          ) : null}
          <Button className="gap-1.5" onClick={onAdd}>
            <Plus className="size-4" /> Кабинет
          </Button>
        </div>
      </div>

      {lowBalance.length > 0 ? (
        <Card className="flex items-start gap-3 border-destructive/40 bg-destructive/5 p-3.5">
          <TrendingDown className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="text-sm">
            <p className="font-medium text-destructive">
              Заканчивается баланс: {lowBalance.length}
            </p>
            <p className="text-muted-foreground">
              {lowBalance.map((a) => a.name).join(', ')} — пополните, чтобы
              реклама не остановилась.
            </p>
          </div>
        </Card>
      ) : null}

      {hasStats ? (
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <BarChart3 className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Динамика лидов и кликов</h3>
          </div>
          <AdsTrendChart accounts={accounts} />
        </Card>
      ) : null}

      {accounts.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="Нет рекламных кабинетов"
          description="Добавьте кабинет (Яндекс Директ, Google Ads и т.д.), затем пополняйте баланс и вносите статистику."
          action={
            <Button className="gap-1.5" onClick={onAdd}>
              <Plus className="size-4" /> Добавить кабинет
            </Button>
          }
        />
      ) : layout === 'table' ? (
        <AdsSummaryTable accounts={accounts} onEdit={onEdit} onTopup={onTopup} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {accounts.map((a) => (
            <AdAccountCard
              key={a.id}
              account={a}
              pending={pending}
              onEdit={() => onEdit(a)}
              onTopup={() => onTopup(a)}
              onStat={() => onStat(a)}
              onSync={() => onSync(a)}
              onDelete={() => onDeleteAccount(a)}
              onDeleteTopup={onDeleteTopup}
              onDeleteStat={onDeleteStat}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function AdsSummaryTable({
  accounts,
  onEdit,
  onTopup,
}: {
  accounts: FinanceAdAccount[]
  onEdit: (a: FinanceAdAccount) => void
  onTopup: (a: FinanceAdAccount) => void
}) {
  const rates = useRates()
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-2.5 font-medium">Кабинет</th>
              <th className="px-4 py-2.5 text-right font-medium">Баланс</th>
              <th className="px-4 py-2.5 text-right font-medium">Расход</th>
              <th className="px-4 py-2.5 text-right font-medium">Лиды</th>
              <th className="px-4 py-2.5 text-right font-medium">CPL</th>
              <th className="px-4 py-2.5 text-right font-medium">CTR</th>
              <th className="px-4 py-2.5 text-right font-medium">CR</th>
              <th className="px-4 py-2.5 text-right font-medium" />
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => {
              const m = accountMetrics(a, rates)
              return (
                <tr
                  key={a.id}
                  className="border-b border-border/60 transition-colors last:border-0 hover:bg-muted/50"
                >
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          AD_STATUS_META[a.status].dot,
                        )}
                      />
                      <button
                        type="button"
                        onClick={() => onEdit(a)}
                        className="truncate font-medium hover:underline"
                      >
                        {a.name}
                      </button>
                      <span className="text-xs text-muted-foreground">
                        {PLATFORM_META[a.platform]}
                      </span>
                    </div>
                  </td>
                  <td
                    className={cn(
                      'px-4 py-3 text-right font-semibold tabular-nums',
                      m.balance <= 0 && 'text-destructive',
                    )}
                  >
                    {formatUsd(m.balance)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatUsd(m.spend)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {formatInt(m.leads)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {m.cpl === Number.POSITIVE_INFINITY
                      ? '—'
                      : formatUsd(m.cpl)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatPct(m.ctr)}
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">
                    {formatPct(m.cr)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => onTopup(a)}
                    >
                      <Plus className="size-3.5" /> Пополнить
                    </Button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

function AdAccountCard({
  account,
  pending,
  onEdit,
  onTopup,
  onStat,
  onSync,
  onDelete,
  onDeleteTopup,
  onDeleteStat,
}: {
  account: FinanceAdAccount
  pending: boolean
  onEdit: () => void
  onTopup: () => void
  onStat: () => void
  onSync: () => void
  onDelete: () => void
  onDeleteTopup: (id: string) => void
  onDeleteStat: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rates = useRates()
  const m = accountMetrics(account, rates)
  const status = AD_STATUS_META[account.status]
  const low = m.balance <= 0

  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate font-semibold">{account.name}</span>
            <Badge
              variant="outline"
              className={cn('gap-1.5 font-medium', status.className)}
            >
              <span className={cn('size-1.5 rounded-full', status.dot)} />
              {status.label}
            </Badge>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {PLATFORM_META[account.platform]}
            {account.accountRef ? ` · ${account.accountRef}` : ''}
          </p>
          {account.externalEnabled ? (
            <Badge
              variant="outline"
              className="mt-1.5 gap-1 border-primary/30 bg-primary/5 text-primary"
            >
              <LinkIcon className="size-3" />
              Яндекс.Директ
            </Badge>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-8"
            onClick={onEdit}
            aria-label="Изменить кабинет"
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 text-destructive hover:text-destructive"
            onClick={onDelete}
            aria-label="Удалить кабинет"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      </div>

      {/* Balance */}
      <div className="mt-4 rounded-lg border border-border bg-muted/30 p-3">
        <span className="text-xs text-muted-foreground">Баланс</span>
        <div
          className={cn(
            'text-3xl font-bold tabular-nums',
            low ? 'text-destructive' : 'text-foreground',
          )}
        >
          {formatUsd(m.balance)}
        </div>
        <div className="mt-1 text-xs text-muted-foreground tabular-nums">
          Пополнено {formatUsd(m.topups)} · Расход{' '}
          {formatUsd(m.spend)}
        </div>
      </div>

      {/* Metrics grid */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <MiniMetric label="Показы" value={formatInt(m.impressions)} />
        <MiniMetric label="Клики" value={formatInt(m.clicks)} />
        <MiniMetric label="Лиды" value={formatInt(m.leads)} />
        <MiniMetric label="CTR" value={formatPct(m.ctr)} />
        <MiniMetric label="Конв." value={formatPct(m.cr)} />
        <MiniMetric
          label="CPL"
          value={
            m.cpl === Number.POSITIVE_INFINITY
              ? '—'
              : formatUsd(m.cpl)
          }
        />
      </div>

      {account.note ? (
        <p className="mt-3 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
          {account.note}
        </p>
      ) : null}

      {/* Sync status (integration) */}
      {account.externalEnabled ? (
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          {account.syncError ? (
            <>
              <AlertTriangle className="size-3.5 text-destructive" />
              <span className="text-destructive">
                Ошибка синхронизации: {account.syncError}
              </span>
            </>
          ) : account.lastSyncAt ? (
            <>
              <RefreshCw className="size-3.5" />
              <span>Синхронизировано {formatDateTime(account.lastSyncAt)}</span>
            </>
          ) : (
            <>
              <AlertTriangle className="size-3.5" />
              <span>Ещё не синхронизировано — нажмите «Обновить».</span>
            </>
          )}
        </div>
      ) : null}

      {/* Actions */}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" className="gap-1.5" onClick={onTopup}>
          <CreditCard className="size-4" /> Пополнить
        </Button>
        {account.externalEnabled ? (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onSync}
            disabled={pending}
          >
            <RefreshCw
              className={cn('size-4', pending && 'animate-spin')}
            />
            Обновить
          </Button>
        ) : (
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5"
            onClick={onStat}
          >
            <BarChart3 className="size-4" /> Статистика
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto gap-1.5"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
          История
        </Button>
      </div>

      {/* History */}
      {open ? (
        <div className="mt-3 grid gap-4 border-t border-border pt-3 md:grid-cols-2">
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Пополнения
            </h4>
            {account.topups.length === 0 ? (
              <p className="text-xs text-muted-foreground">Нет пополнений.</p>
            ) : (
              <ul className="space-y-1.5">
                {account.topups.map((t) => (
                  <li
                    key={t.id}
                    className="flex items-center justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <div className="min-w-0">
                      <span className="font-medium tabular-nums text-success">
                        +{formatUsd(toUsd(t.amount, account.currency, rates))}
                      </span>
                      <span className="ml-2 text-xs text-muted-foreground">
                        {formatDate(t.topupDate)}
                      </span>
                      {t.note ? (
                        <p className="truncate text-xs text-muted-foreground">
                          {t.note}
                        </p>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onDeleteTopup(t.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Удалить пополнение"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Статистика
            </h4>
            {account.stats.length === 0 ? (
              <p className="text-xs text-muted-foreground">Нет записей.</p>
            ) : (
              <ul className="space-y-1.5">
                {account.stats.map((st) => (
                  <li
                    key={st.id}
                    className="flex items-start justify-between gap-2 rounded-md bg-muted/30 px-2.5 py-1.5 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="text-xs text-muted-foreground">
                        {formatDate(st.periodStart)} — {formatDate(st.periodEnd)}
                      </div>
                      <div className="tabular-nums">
                        <span className="font-medium text-destructive">
                          −{formatUsd(toUsd(st.spend, account.currency, rates))}
                        </span>
                        <span className="ml-2 text-xs text-muted-foreground">
                          {formatInt(st.clicks)} кл · {formatInt(st.leads)} лид.
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onDeleteStat(st.id)}
                      className="shrink-0 text-muted-foreground hover:text-destructive"
                      aria-label="Удалить запись статистики"
                    >
                      <X className="size-4" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </Card>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-card px-1 py-2">
      <div className="text-sm font-semibold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground">{label}</div>
    </div>
  )
}

/* ================================================================== */
/* Expenses panel                                                      */
/* ================================================================== */

function ExpensesPanel({
  resource,
  sections,
  entries,
  pending,
  run,
  onAddEntry,
  onEditEntry,
  onDeleteEntry,
  onDeleteSection,
}: {
  resource: FinanceResource
  sections: FinanceSection[]
  entries: FinanceEntry[]
  pending: boolean
  run: (fn: () => Promise<FinanceResult>, onOk?: () => void) => void
  onAddEntry: (sectionId: string) => void
  onEditEntry: (entry: FinanceEntry) => void
  onDeleteEntry: (entry: FinanceEntry) => void
  onDeleteSection: (section: FinanceSection) => void
}) {
  const [sectionId, setSectionId] = useState<string | null>(null)
  const [newSection, setNewSection] = useState('')
  const [renaming, setRenaming] = useState<FinanceSection | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [sortField, setSortField] = useState<SortField>('date')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const activeSection =
    sections.find((s) => s.id === sectionId) ?? sections[0] ?? null

  const sectionEntries = useMemo(
    () =>
      activeSection
        ? entries.filter((e) => e.sectionId === activeSection.id)
        : [],
    [entries, activeSection],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = sectionEntries.filter((e) => {
      if (statusFilter !== 'all' && e.status !== statusFilter) return false
      if (
        q &&
        !e.title.toLowerCase().includes(q) &&
        !e.vendor.toLowerCase().includes(q) &&
        !e.notes.toLowerCase().includes(q)
      ) {
        return false
      }
      return true
    })
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      switch (sortField) {
        case 'title':
          return a.title.localeCompare(b.title) * dir
        case 'amount':
          return (a.amount - b.amount) * dir
        case 'status':
          return a.status.localeCompare(b.status) * dir
        default:
          return (
            (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0) *
            dir
          )
      }
    })
  }, [sectionEntries, search, statusFilter, sortField, sortDir])

  const sectionTotal = sectionEntries
    .filter((e) => e.status !== 'cancelled')
    .reduce((s, e) => s + e.amount, 0)

  function totalFor(id: string) {
    return entries
      .filter((e) => e.sectionId === id && e.status !== 'cancelled')
      .reduce((s, e) => s + e.amount, 0)
  }

  function toggleSort(field: SortField) {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortField(field)
      setSortDir(field === 'title' ? 'asc' : 'desc')
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Section tabs */}
      <div className="flex flex-wrap items-center gap-2">
        {sections.map((s) => {
          const active = activeSection?.id === s.id
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setSectionId(s.id)}
              className={cn(
                'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-foreground'
                  : 'border-border bg-card hover:bg-muted',
              )}
            >
              <Layers className="size-3.5 text-muted-foreground" />
              <span className="max-w-[160px] truncate font-medium">
                {s.name}
              </span>
              <span className="tabular-nums text-xs text-muted-foreground">
                {formatUsd(totalFor(s.id))}
              </span>
            </button>
          )
        })}
        <AddSectionInline
          value={newSection}
          onChange={setNewSection}
          pending={pending}
          onSubmit={() => {
            const name = newSection.trim()
            if (!name) return
            run(() => createSectionAction(resource.id, name), () =>
              setNewSection(''),
            )
          }}
        />
      </div>

      {!activeSection ? (
        <EmptyState
          icon={FolderPlus}
          title="Нет вкладок расходов"
          description="Создайте вкладку (например, «Материал��» или «Хостинг»), чтобы добавлять расходы."
        />
      ) : (
        <>
          {/* Section toolbar */}
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold">{activeSection.name}</h3>
                <Badge variant="outline" className="tabular-nums font-medium">
                  {formatUsd(sectionTotal)}
                </Badge>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => {
                    setRenaming(activeSection)
                    setRenameValue(activeSection.name)
                  }}
                >
                  <Pencil className="size-4" /> Переименовать
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 text-destructive hover:text-destructive"
                  onClick={() => onDeleteSection(activeSection)}
                  aria-label="Удалить вкладку"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            </div>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <div className="relative flex-1">
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Поиск по названию, контрагенту, заметке…"
                  className="pl-3"
                />
              </div>
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as StatusFilter)}
              >
                <SelectTrigger className="w-full sm:w-44">
                  <SelectValue placeholder="Статус" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Все статусы</SelectItem>
                  {FINANCE_ENTRY_STATUSES.map((s) => (
                    <SelectItem key={s} value={s}>
                      {STATUS_META[s].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                className="gap-1.5"
                onClick={() => onAddEntry(activeSection.id)}
              >
                <Plus className="size-4" /> Расход
              </Button>
            </div>
          </div>

          {/* Table */}
          {filtered.length === 0 ? (
            <EmptyState
              icon={ListChecks}
              title="Нет расходов"
              description="Добавьте первый расход в эту вкладку."
              action={
                <Button
                  className="gap-1.5"
                  onClick={() => onAddEntry(activeSection.id)}
                >
                  <Plus className="size-4" /> Добавить расход
                </Button>
              }
            />
          ) : (
            <Card className="overflow-hidden p-0">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="w-8 px-3 py-2.5" />
                      <SortableTh
                        label="Расход"
                        field="title"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <th className="px-3 py-2.5 font-medium">Контрагент</th>
                      <SortableTh
                        label="Статус"
                        field="status"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="Дата"
                        field="date"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                      />
                      <SortableTh
                        label="Сумма"
                        field="amount"
                        active={sortField}
                        dir={sortDir}
                        onSort={toggleSort}
                        align="right"
                      />
                      <th className="w-20 px-3 py-2.5" />
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((e) => {
                      const isOpen = expanded.has(e.id)
                      const doneTasks = e.tasks.filter((t) => t.done).length
                      return (
                        <ExpenseRow
                          key={e.id}
                          entry={e}
                          currency={resource.currency}
                          isOpen={isOpen}
                          doneTasks={doneTasks}
                          pending={pending}
                          onToggle={() => toggleExpanded(e.id)}
                          onEdit={() => onEditEntry(e)}
                          onDelete={() => onDeleteEntry(e)}
                          run={run}
                        />
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {/* Rename section dialog */}
      <Dialog
        open={renaming != null}
        onOpenChange={(o) => {
          if (!o) setRenaming(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Переименовать вкладку</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="rename-section">Название</Label>
            <Input
              id="rename-section"
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter>
            <DialogClose render={<Button variant="outline">Отмена</Button>} />
            <Button
              disabled={pending || !renameValue.trim()}
              onClick={() => {
                if (!renaming) return
                run(
                  () => renameSectionAction(renaming.id, renameValue.trim()),
                  () => setRenaming(null),
                )
              }}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                'Сохранить'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function AddSectionInline({
  value,
  onChange,
  pending,
  onSubmit,
}: {
  value: string
  onChange: (v: string) => void
  pending: boolean
  onSubmit: () => void
}) {
  const [open, setOpen] = useState(false)
  if (!open) {
    return (
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => setOpen(true)}
      >
        <FolderPlus className="size-4" /> Вклад��а
      </Button>
    )
  }
  return (
    <form
      className="flex items-center gap-1.5"
      onSubmit={(e) => {
        e.preventDefault()
        onSubmit()
      }}
    >
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Название вкладки"
        className="h-8 w-44"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            setOpen(false)
            onChange('')
          }
        }}
      />
      <Button type="submit" size="sm" disabled={pending || !value.trim()}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
      </Button>
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8"
        onClick={() => {
          setOpen(false)
          onChange('')
        }}
      >
        <X className="size-4" />
      </Button>
    </form>
  )
}

function SortableTh({
  label,
  field,
  active,
  dir,
  onSort,
  align = 'left',
}: {
  label: string
  field: SortField
  active: SortField
  dir: SortDir
  onSort: (f: SortField) => void
  align?: 'left' | 'right'
}) {
  return (
    <th
      className={cn(
        'px-3 py-2.5 font-medium',
        align === 'right' ? 'text-right' : 'text-left',
      )}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        className={cn(
          'inline-flex items-center gap-1 hover:text-foreground',
          align === 'right' && 'flex-row-reverse',
        )}
      >
        {label}
        {active === field ? (
          dir === 'asc' ? (
            <ArrowUp className="size-3" />
          ) : (
            <ArrowDown className="size-3" />
          )
        ) : (
          <ArrowUpDown className="size-3 opacity-50" />
        )}
      </button>
    </th>
  )
}

function ExpenseRow({
  entry,
  isOpen,
  doneTasks,
  pending,
  onToggle,
  onEdit,
  onDelete,
  run,
}: {
  entry: FinanceEntry
  currency: FinanceCurrency
  isOpen: boolean
  doneTasks: number
  pending: boolean
  onToggle: () => void
  onEdit: () => void
  onDelete: () => void
  run: (fn: () => Promise<FinanceResult>, onOk?: () => void) => void
}) {
  const [taskInput, setTaskInput] = useState('')
  const total = entry.tasks.length
  const progress = total > 0 ? Math.round((doneTasks / total) * 100) : 0

  return (
    <>
      <tr className="border-b border-border last:border-0 hover:bg-muted/30">
        <td className="px-3 py-2.5 align-top">
          <button
            type="button"
            onClick={onToggle}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Раскрыть детали"
          >
            {isOpen ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </button>
        </td>
        <td className="px-3 py-2.5 align-top">
          <div className="font-medium">{entry.title}</div>
          {total > 0 ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              Задачи: {doneTasks}/{total}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top text-muted-foreground">
          {entry.vendor || '—'}
        </td>
        <td className="px-3 py-2.5 align-top">
          <Badge
            variant="outline"
            className={cn('font-medium', STATUS_META[entry.status].className)}
          >
            {STATUS_META[entry.status].label}
          </Badge>
        </td>
        <td className="px-3 py-2.5 align-top whitespace-nowrap text-muted-foreground">
          {formatDate(entry.entryDate)}
          {entry.dueDate ? (
            <div className="text-xs">до {formatDate(entry.dueDate)}</div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top text-right font-semibold tabular-nums">
          {formatUsd(entry.amount)}
          {entry.origCurrency !== 'USD' && entry.origCurrency !== 'USDT' ? (
            <div className="text-xs font-normal text-muted-foreground">
              {formatMoney(entry.origAmount, entry.origCurrency)}
            </div>
          ) : null}
        </td>
        <td className="px-3 py-2.5 align-top">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="size-8"
              onClick={onEdit}
              aria-label="Изменить"
            >
              <Pencil className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-destructive hover:text-destructive"
              onClick={onDelete}
              aria-label="Удалить"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        </td>
      </tr>
      {isOpen ? (
        <tr className="border-b border-border bg-muted/20">
          <td />
          <td colSpan={6} className="px-3 py-3">
            <div className="grid gap-4 md:grid-cols-2">
              <div>
                <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Заметки / ответы
                </h4>
                <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                  {entry.notes || 'Нет заметок.'}
                </p>
              </div>
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Чек-лист задач
                  </h4>
                  {total > 0 ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {doneTasks}/{total} · {progress}%
                    </span>
                  ) : null}
                </div>
                {total > 0 ? (
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-success transition-all"
                      style={{ width: `${progress}%` }}
                    />
                  </div>
                ) : null}
                <ul className="space-y-1">
                  {entry.tasks.map((t) => (
                    <li key={t.id} className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() =>
                          run(() => toggleTaskAction(t.id, !t.done))
                        }
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border',
                          t.done
                            ? 'border-success bg-success text-success-foreground'
                            : 'border-input',
                        )}
                        aria-label={t.done ? 'Снять отметку' : 'Отметить выполненным'}
                      >
                        {t.done ? <Check className="size-3" /> : null}
                      </button>
                      <span
                        className={cn(
                          'flex-1 text-sm',
                          t.done && 'text-muted-foreground line-through',
                        )}
                      >
                        {t.label}
                      </span>
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => run(() => deleteTaskAction(t.id))}
                        className="text-muted-foreground hover:text-destructive"
                        aria-label="Удалить пункт"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
                </ul>
                <form
                  className="mt-2 flex items-center gap-1.5"
                  onSubmit={(ev) => {
                    ev.preventDefault()
                    const label = taskInput.trim()
                    if (!label) return
                    run(
                      () => addTaskAction(entry.id, label),
                      () => setTaskInput(''),
                    )
                  }}
                >
                  <Input
                    value={taskInput}
                    onChange={(ev) => setTaskInput(ev.target.value)}
                    placeholder="Новый пункт…"
                    className="h-8"
                  />
                  <Button
                    type="submit"
                    size="sm"
                    variant="outline"
                    disabled={pending || !taskInput.trim()}
                  >
                    <Plus className="size-4" />
                  </Button>
                </form>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  )
}

