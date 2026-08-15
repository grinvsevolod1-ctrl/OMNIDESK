'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Copy,
  FileText,
  Globe,
  KeyRound,
  Link2,
  Loader2,
  MoreVertical,
  Pencil,
  Plus,
  Trash2,
  Zap,
} from 'lucide-react'
import {
  secretCreateSiteAction,
  secretDeleteSiteAction,
  secretGetSiteAction,
  secretGetSiteKeyAction,
  secretRotateSiteKeyAction,
  type SiteListItem,
} from '@/app/actions/admin-secret'
import type { GodSite } from '@/lib/god-sites'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/page-parts'
import { SiteEditor } from '@/components/admin/secret-sites/site-editor'
import { ReportDialog } from '@/components/admin/secret-sites/report-dialog'

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
  sites,
  beta = false,
}: {
  sites: SiteListItem[]
  /** Beta tab: unlocks the one-click extension download in the editor. */
  beta?: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [newKey, setNewKey] = useState<{
    title: string
    slug: string
    key: string
  } | null>(null)
  const [openSite, setOpenSite] = useState<GodSite | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [reportOpen, setReportOpen] = useState(false)

  // Auto-refresh the list every 30s so the "на связи" dot and «Опрос»
  // column stay honest without a manual reload. Paused while the editor is
  // open — a refresh there would be useless churn (the editor owns its copy).
  useEffect(() => {
    if (openSite) return
    const t = setInterval(() => router.refresh(), 30_000)
    return () => clearInterval(t)
  }, [openSite, router])

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
      router.refresh()
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

  function removeSite(id: string) {
    startTransition(async () => {
      try {
        const res = await secretDeleteSiteAction(id)
        if (res.ok) toast.success(res.message)
        else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      router.refresh()
    })
  }

  if (openSite) {
    return (
      <SiteEditor
        site={openSite}
        beta={beta}
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
          правите здесь, она покажет при следующем опросе или сразу по SSE.
          {beta && (
            <>
              {' '}
              <span className="font-medium text-foreground">
                Откройте сайт и нажмите «Скачать расширение» — получите готовый
                архив под этот сайт (токен вшивается автоматически).
              </span>
            </>
          )}
        </p>
        <div className="flex items-center gap-2">
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
      ) : (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {sites.map((s) => {
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
                      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                        {s.slug}
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
        onCreated={(title, slug, key) => setNewKey({ title, slug, key })}
      />
      <ApiKeyDialog data={newKey} onClose={() => setNewKey(null)} />

      <ReportDialog open={reportOpen} onOpenChange={setReportOpen} />
    </div>
  )
}

/* ------------------------------ Dialogs -------------------------------- */

function CreateSiteDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (title: string, slug: string, apiKey: string) => void
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [slug, setSlug] = useState('')
  const [title, setTitle] = useState('')

  function submit() {
    startTransition(async () => {
      try {
        const res = await secretCreateSiteAction(slug, title)
        if (res.ok && res.apiKey) {
          onOpenChange(false)
          setSlug('')
          setTitle('')
          // Use the server-NORMALIZED slug («my_site» → «my-site»), not the
          // raw input — the key dialog must show the real PAGE_ID.
          onCreated(title, res.slug ?? slug.trim().toLowerCase(), res.apiKey)
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      router.refresh()
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Новый управляемый сайт</DialogTitle>
          <DialogDescription>
            После создания вы получите постоянный токен и готовую строку
            параметров для витрины. Токен можно посмотреть в любой момент
            через меню сайта.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-title">Название</Label>
            <Input
              id="site-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Кабинет «Директ Про»"
            />
            <p className="text-xs text-muted-foreground">
              Только для этого списка — витрина его не видит.
            </p>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-slug">Идентификатор страницы (slug)</Label>
            <Input
              id="site-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="direct-pro-1"
              className="font-mono"
            />
            <p className="text-xs text-muted-foreground">
              Латиница, цифры и дефисы. Войдёт в адрес API — потом не поменять.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button
            onClick={submit}
            disabled={pending || !slug.trim() || !title.trim()}
            className="press-scale"
          >
            {pending ? <Loader2 className="size-4 animate-spin" /> : 'Создать'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ApiKeyDialog({
  data,
  onClose,
}: {
  data: { title: string; slug: string; key: string } | null
  onClose: () => void
}) {
  function copy(value: string, label: string) {
    void navigator.clipboard.writeText(value)
    toast.success(label)
  }

  return (
    <Dialog open={Boolean(data)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Подключение витрины</DialogTitle>
          <DialogDescription>
            {data?.title}
            {' — постоянный токен этого сайта. Все скачанные расширения используют его же.'}
          </DialogDescription>
        </DialogHeader>
        {data && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">Токен</Label>
              <div className="flex items-center gap-2">
                <Input readOnly value={data.key} className="font-mono text-xs" />
                <Button
                  size="sm"
                  variant="outline"
                  className="press-scale shrink-0 gap-1.5"
                  onClick={() => copy(data.key, 'Токен скопирован')}
                >
                  <Copy className="size-4" />
                  Копировать
                </Button>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs text-muted-foreground">
                Параметры для страницы-витрины
              </Label>
              <button
                type="button"
                onClick={() =>
                  // Copy the SAME absolute string shown on screen: the vitrine
                  // lives on a foreign domain, so a relative `?api=/api/ext`
                  // would point at the vitrine's own host, not the panel.
                  copy(
                    `?api=${window.location.origin}/api/ext&page=${data.slug}&token=${data.key}`,
                    'Строка параметров скопирована',
                  )
                }
                title="Скопировать строку параметров"
                className="rounded-md border bg-muted/50 p-2.5 text-left font-mono text-xs leading-relaxed break-all transition-colors hover:bg-muted"
              >
                {`?api=${typeof window !== 'undefined' ? window.location.origin : ''}/api/ext&page=${data.slug}&token=${data.key}`}
              </button>
              <p className="text-xs text-muted-foreground">
                Нажмите, чтобы скопировать готовую строку и добавьте её к
                адресу витрины.
              </p>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button onClick={onClose} className="press-scale">
            Готово
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
