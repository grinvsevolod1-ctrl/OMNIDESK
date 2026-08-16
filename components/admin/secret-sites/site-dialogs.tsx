'use client'

/**
 * Диалоги вкладки «Сайты» god-панели: создание управляемого сайта и показ
 * постоянного токена/строки параметров витрины. Вынесено из secret-sites-tab.tsx.
 * Часть god-панели — инварианты AGENTS.md §4.
 */

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Copy, Loader2 } from 'lucide-react'
import { secretCreateSiteAction } from '@/app/actions/admin-secret'
import { Button } from '@/components/ui/button'
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

export function CreateSiteDialog({
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

export function ApiKeyDialog({
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
