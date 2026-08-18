'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import useSWR from 'swr'
import { toast } from 'sonner'
import {
  Copy,
  Download,
  FileText,
  Globe,
  KeyRound,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Puzzle,
  Search,
  Trash2,
  Zap,
} from 'lucide-react'
import {
  secretDeleteSiteAction,
  secretDownloadExtensionAction,
  secretGetSiteAction,
  secretGetSiteKeyAction,
  secretListSitesAction,
  secretRotateSiteKeyAction,
  type SiteListItem,
} from '@/app/actions/admin-secret'
import { downloadBase64Zip } from '@/components/admin/secret-sites/download-zip'
import type { GodSite } from '@/lib/god-sites'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EmptyState } from '@/components/page-parts'
import { SiteEditor } from '@/components/admin/secret-sites/site-editor'
import { ReportDialog } from '@/components/admin/secret-sites/report-dialog'
import { ApiKeyDialog, CreateSiteDialog } from '@/components/admin/secret-sites/site-dialogs'

/**
 * God-panel "Сайты" tab — managed external mockups (page3.html contract).
 * The list comes from the server page; the full state loads on demand when a
 * site is opened. SACRED INVARIANT (AGENTS.md §4): god-panel only.
 */

function fmtRelative(iso: string | null): string {
  if (!iso) return 'ещё не подключалась'
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 'ещё не подключалась'
  const sec = Math.max(0, Math.floor((Date.now() - t) / 1000))
  if (sec < 60) return 'только что'
  if (sec < 3600) return `${Math.floor(sec / 60)} мин назад`
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч назад`
  return new Date(iso).toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
  })
}

function fmtMoney(n: number, currency: string): string {
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(n)} ${currency}`
}

/** Is the page alive? Considered online when polled within the last minute. */
function isOnline(lastSeenAt: string | null): boolean {
  if (!lastSeenAt) return false
  return Date.now() - new Date(lastSeenAt).getTime() < 60_000
}

export function SecretSitesTab({
  sites: initialSites,
}: {
  sites: SiteListItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [newKey, setNewKey] = useState<{
    title: string
    slug: string
    key: string
  } | null>(null)
  const [openSite, setOpenSite] = useState<GodSite | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)

  // Auto-refresh the list every 30s so the "на связи" dot and «Опрос»
  // column stay honest without a manual reload. Точечный SWR-запрос только
  // за списком сайтов вместо прежнего router.refresh(): полный refresh
  // перерендеривал ВСЁ server-дерево god-панели каждые 30 секунд.
  // Paused while the editor is open — the editor owns its copy.
  const { data: sites = initialSites, mutate: mutateSites } = useSWR(
    openSite ? null : 'god-sites-list',
    () => secretListSitesAction(),
    {
      fallbackData: initialSites,
      refreshInterval: 30_000,
      revalidateOnFocus: true,
      keepPreviousData: true,
    },
  )

  function openEditor(id: string) {
    setLoadingId(id)
    startTransition(async () => {
      try {
        const site = await secretGetSiteAction(id)
        if (site) setOpenSite(site)
        else toast.error('Сайт не найден')
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      setLoadingId(null)
    })
  }

  function rotateKey(id: string, title: string, slug: string) {
    startTransition(async () => {
      try {
        const res = await secretRotateSiteKeyAction(id)
        if (res.ok && res.apiKey) {
          setNewKey({ title, slug, key: res.apiKey })
          toast.success(res.message)
        } else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      void mutateSites()
    })
  }

  /** Show the permanent token (migration 137) — re-showable any time. */
  function showKey(id: string, title: string, slug: string) {
    startTransition(async () => {
      try {
        const res = await secretGetSiteKeyAction(id)
        if (res.ok && res.apiKey) {
          setNewKey({ title, slug, key: res.apiKey })
        } else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
    })
  }

  /**
   * One-click extension download straight from the list card — previously
   * this required opening the full editor. Rebuilds the archive with the
   * PERMANENT token (migration 137 — old archives keep working) and bumps
   * the manifest version.
   */
  function downloadExtension(id: string) {
    startTransition(async () => {
      try {
        const res = await secretDownloadExtensionAction(id)
        if (res.ok && res.base64 && res.fileName) {
          downloadBase64Zip(res.base64, res.fileName)
          toast.success(res.message)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Не удалось собрать расширение')
      }
      void mutateSites()
    })
  }

  function removeSite(id: string) {
    startTransition(async () => {
      try {
        const res = await secretDeleteSiteAction(id)
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      void mutateSites()
    })
  }

  // Client-side filter over title / slug / «яндекс N» label. Kept outside
  // early returns so hook order is stable across the editor toggle.
  const visibleSites = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return sites
    return sites.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.slug.toLowerCase().includes(q) ||
        (s.extLabelSeq != null && `яндекс ${s.extLabelSeq}`.includes(q)),
    )
  }, [sites, search])

  if (openSite) {
    return (
      <SiteEditor
        site={openSite}
        onClose={() => {
          setOpenSite(null)
          router.refresh()
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <p className="max-w-xl text-sm text-muted-foreground text-pretty">
          Внешние страницы-витрины. Витрина только читает данные — всё, что вы
          правите здесь, она покажет при следующем опросе или сразу по SSE.{' '}
          <span className="font-medium text-foreground">
            «Скачать расширение» — готовый архив под сайт, токен вшивается
            автоматически и остаётся постоянным.
          </span>
        </p>
        <div className="flex items-center gap-2">
          {sites.length > 3 && (
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Поиск: название, slug, яндекс N"
                aria-label="Поиск по сайтам"
                className="h-8 w-56 pl-8 text-sm"
              />
            </div>
          )}
          {sites.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => setReportOpen(true)}
              className="press-scale gap-1.5"
            >
              <FileText className="size-4" />
              Сформировать отчёт
            </Button>
          )}
          <Button
            size="sm"
            onClick={() => setCreateOpen(true)}
            className="press-scale gap-1.5"
          >
            <Plus className="size-4" />
            Добавить сайт
          </Button>
        </div>
      </div>

      {sites.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="Нет управляемых сайтов"
          description="Создайте сайт — получите постоянный токен и подключите витрину за минуту."
        />
      ) : visibleSites.length === 0 ? (
        <EmptyState
          icon={Search}
          title="Ничего не найдено"
          description={`По запросу «${search.trim()}» нет сайтов — проверьте название или slug.`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {visibleSites.map((s) => {
            const online = isOnline(s.lastSeenAt)
            return (
              <Card key={s.id} className="flex flex-col gap-0 overflow-hidden p-0">
                {/* Header: identity + actions */}
                <div className="flex items-start justify-between gap-3 p-4 pb-3">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <Globe className="size-4 text-muted-foreground" />
                      <span
                        className={`absolute -right-0.5 -top-0.5 size-2.5 rounded-full ring-2 ring-card ${
                          online ? 'bg-success animate-pulse' : 'bg-muted-foreground/40'
                        }`}
                        title={online ? 'Страница на связи' : 'Не на связи'}
                      />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="truncate font-medium leading-tight">
                          {s.title}
                        </p>
                        {s.autoSpendEnabled && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-success"
                            title={`Авто-скрутка: ${new Intl.NumberFormat('ru-RU').format(s.autoDailyBudget)} ${s.currency} в день`}
                          >
                            <Zap className="size-2.5" />
                            Авто
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 flex items-center gap-2 truncate font-mono text-xs text-muted-foreground">
                        <span className="truncate">{s.slug}</span>
                        {s.extLabelSeq != null && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px]"
                            title={`Расширение «яндекс ${s.extLabelSeq}», версия 1.0.${s.extVersion}`}
                          >
                            <Puzzle className="size-2.5" />
                            {`яндекс ${s.extLabelSeq} · v1.0.${s.extVersion}`}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={pending}
                          className="press-scale size-8 shrink-0 p-0"
                          aria-label="Действия с сайтом"
                        >
                          <MoreVertical className="size-4" />
                        </Button>
                      }
                    />
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => downloadExtension(s.id)}
                        className="gap-2"
                      >
                        <Download className="size-4" />
                        Скачать расширение
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => showKey(s.id, s.title, s.slug)}
                        className="gap-2"
                      >
                        <Copy className="size-4" />
                        Показать токен
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => {
                          if (
                            window.confirm(
                              `Заменить токен «${s.title}»? ВСЕ скачанные расширения этого сайта перестанут работать — их придётся перекачать.`,
                            )
                          )
                            rotateKey(s.id, s.title, s.slug)
                        }}
                        className="gap-2"
                      >
                        <KeyRound className="size-4" />
                        Заменить токен
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        variant="destructive"
                        className="gap-2"
                        onClick={() => {
                          if (
                            window.confirm(
                              `Удалить «${s.title}»? Витрина сразу перестанет получать данные.`,
                            )
                          )
                            removeSite(s.id)
                        }}
                      >
                        <Trash2 className="size-4" />
                        Удалить сайт
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                {/* Vital stats */}
                <div className="grid grid-cols-3 gap-px bg-border">
                  <div className="flex flex-col gap-0.5 bg-card px-4 py-2.5">
                    <span className="text-xs text-muted-foreground">Баланс</span>
                    <span className="truncate font-mono text-sm font-semibold">
                      {fmtMoney(s.balance, s.currency)}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 bg-card px-4 py-2.5">
                    <span className="text-xs text-muted-foreground">Кампаний</span>
                    <span className="font-mono text-sm font-semibold">
                      {s.campaignsCount}
                    </span>
                  </div>
                  <div className="flex flex-col gap-0.5 bg-card px-4 py-2.5">
                    <span className="text-xs text-muted-foreground">Опрос</span>
                    <span
                      className={`truncate text-sm font-medium ${
                        online ? 'text-success' : 'text-muted-foreground'
                      }`}
                    >
                      {fmtRelative(s.lastSeenAt)}
                    </span>
                  </div>
                </div>

                {/* Footer: endpoint + edit */}
                <div className="flex items-center justify-between gap-2 border-t p-3">
                  <button
                    type="button"
                    onClick={() => {
                      void navigator.clipboard.writeText(
                        `/api/ext/pages/${s.slug}/state`,
                      )
                      toast.success('Эндпоинт скопирован')
                    }}
                    title="Скопировать эндпоинт"
                    className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 font-mono text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    <Link2 className="size-3.5 shrink-0" />
                    <span className="truncate">{`/api/ext/pages/${s.slug}/state`}</span>
                  </button>
                  <Button
                    size="sm"
                    onClick={() => openEditor(s.id)}
                    disabled={pending}
                    className="press-scale shrink-0 gap-1.5"
                  >
                    {loadingId === s.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Pencil className="size-3.5" />
                    )}
                    Редактировать
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      <CreateSiteDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(title, slug, key) => {
          setNewKey({ title, slug, key })
          // Список теперь живёт в SWR — router.refresh() внутри диалога его
          // не обновит, ревалидируем явно, чтобы новый сайт появился сразу.
          void mutateSites()
        }}
      />
      <ApiKeyDialog data={newKey} onClose={() => setNewKey(null)} />

      <ReportDialog
        open={reportOpen}
        onOpenChange={setReportOpen}
        sites={sites.map((s) => ({ id: s.id, title: s.title }))}
      />
    </div>
  )
}
