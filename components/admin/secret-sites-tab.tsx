'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import {
  Copy,
  Globe,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
} from 'lucide-react'
import {
  secretCreateSiteAction,
  secretDeleteSiteAction,
  secretGetSiteAction,
  secretRotateSiteKeyAction,
  type SiteListItem,
} from '@/app/actions/admin-secret'
import type { GodSite } from '@/lib/god-sites'
import { Badge } from '@/components/ui/badge'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { EmptyState } from '@/components/page-parts'
import { SiteEditor } from '@/components/admin/secret-sites/site-editor'

/**
 * God-panel "Сайты" tab — managed external mockups (page3.html contract).
 * The list comes from the server page; the full state loads on demand when a
 * site is opened. SACRED INVARIANT (AGENTS.md §4): god-panel only.
 */

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
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

export function SecretSitesTab({ sites }: { sites: SiteListItem[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [createOpen, setCreateOpen] = useState(false)
  const [newKey, setNewKey] = useState<{ title: string; key: string } | null>(
    null,
  )
  const [openSite, setOpenSite] = useState<GodSite | null>(null)
  const [loadingId, setLoadingId] = useState<string | null>(null)

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

  function rotateKey(id: string, title: string) {
    startTransition(async () => {
      try {
        const res = await secretRotateSiteKeyAction(id)
        if (res.ok && res.apiKey) {
          setNewKey({ title, key: res.apiKey })
          toast.success(res.message)
        } else toast.error(res.message)
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      router.refresh()
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
        onClose={() => {
          setOpenSite(null)
          router.refresh()
        }}
      />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground text-pretty">
          Внешние страницы-макеты, которые тянут данные отсюда по ключу
          (эндпоинт <code className="text-foreground">/api/ext/&lt;key&gt;</code>
          ). Сервер — источник истины: всё, что вы правите здесь, страница
          показывает при следующем опросе.
        </p>
        <Button
          size="sm"
          onClick={() => setCreateOpen(true)}
          className="press-scale gap-1.5"
        >
          <Plus className="size-4" />
          Добавить сайт
        </Button>
      </div>

      {sites.length === 0 ? (
        <EmptyState
          icon={Globe}
          title="Нет управляемых сайтов"
          description="Создайте сайт — получите одноразовый API-ключ и укажите его в параметре ?api страницы-макета."
        />
      ) : (
        <div className="flex flex-col gap-3">
          {sites.map((s) => (
            <Card key={s.id} className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className={`size-2 shrink-0 rounded-full ${
                      isOnline(s.lastSeenAt) ? 'bg-success' : 'bg-muted-foreground/40'
                    }`}
                    title={isOnline(s.lastSeenAt) ? 'Страница на связи' : 'Не на связи'}
                  />
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{s.title}</span>
                      <Badge variant="outline" className="shrink-0 font-mono text-xs">
                        {s.slug}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {'Кампаний: '}
                      {s.campaignsCount}
                      {' · Баланс: '}
                      {fmtMoney(s.balance, s.currency)}
                      {' · Опрос: '}
                      {fmtDate(s.lastSeenAt)}
                      {' · rev '}
                      {s.revision}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    onClick={() => openEditor(s.id)}
                    disabled={pending}
                    className="press-scale"
                  >
                    {loadingId === s.id ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      'Редактировать'
                    )}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => rotateKey(s.id, s.title)}
                    disabled={pending}
                    title="Заменить API-ключ — старый перестанет работать сразу"
                    className="press-scale gap-1.5"
                  >
                    <KeyRound className="size-4" />
                    Ключ
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Удалить «${s.title}»? Ключ перестанет работать сразу.`,
                        )
                      )
                        removeSite(s.id)
                    }}
                    disabled={pending}
                    className="press-scale border-destructive/40 text-destructive hover:text-destructive"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <CreateSiteDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(title, key) => setNewKey({ title, key })}
      />
      <ApiKeyDialog data={newKey} onClose={() => setNewKey(null)} />
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
  onCreated: (title: string, apiKey: string) => void
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
          onCreated(title, res.apiKey)
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
            После создания вы получите API-ключ. Он показывается один раз —
            хранится только его отпечаток.
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
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="site-slug">Slug</Label>
            <Input
              id="site-slug"
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              placeholder="direct-pro-1"
              className="font-mono"
            />
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
  data: { title: string; key: string } | null
  onClose: () => void
}) {
  return (
    <Dialog open={Boolean(data)} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>API-ключ — сохраните сейчас</DialogTitle>
          <DialogDescription>
            {data?.title}
            {' — ключ показывается только один раз. Подставьте его в '}
            <code>?api=…/api/ext/&lt;ключ&gt;</code> на странице-макете.
          </DialogDescription>
        </DialogHeader>
        {data && (
          <div className="flex items-center gap-2">
            <Input readOnly value={data.key} className="font-mono text-xs" />
            <Button
              size="sm"
              variant="outline"
              className="press-scale shrink-0 gap-1.5"
              onClick={() => {
                void navigator.clipboard.writeText(data.key)
                toast.success('Ключ скопирован')
              }}
            >
              <Copy className="size-4" />
              Копировать
            </Button>
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
