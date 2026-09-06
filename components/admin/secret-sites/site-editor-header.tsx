'use client'

import {
  ArrowLeft,
  Ban,
  ClipboardCopy,
  Download,
  Loader2,
  RefreshCw,
  Save,
} from 'lucide-react'
import { toast } from 'sonner'
import type { GodSite, SiteState } from '@/lib/god-sites'
import { Button } from '@/components/ui/button'

/**
 * Top-of-editor status region: sticky save/back toolbar plus the blocked and
 * version-conflict banners. Purely presentational — every action is a callback
 * owned by useSiteEditor.
 */
export function SiteEditorHeader({
  site,
  state,
  dirty,
  pending,
  conflict,
  onBack,
  onToggleBlocked,
  onDownloadExtension,
  onSave,
  onReloadFresh,
}: {
  site: GodSite
  state: SiteState
  dirty: boolean
  pending: boolean
  conflict: boolean
  onBack: () => void
  onToggleBlocked: () => void
  onDownloadExtension: () => void
  onSave: () => void
  onReloadFresh: () => void
}) {
  const running = state.campaigns.filter((c) => c.status === 'running').length

  return (
    <>
      {/* Sticky toolbar: always-reachable save + dirty indicator */}
      <div className="sticky top-0 z-10 -mx-1 flex flex-wrap items-center justify-between gap-3 rounded-lg border bg-card/95 px-3 py-2.5 backdrop-blur supports-[backdrop-filter]:bg-card/80">
        <div className="flex min-w-0 items-center gap-3">
          <Button
            size="sm"
            variant="ghost"
            onClick={onBack}
            className="press-scale shrink-0 gap-1.5"
          >
            <ArrowLeft className="size-4" />
            Назад
          </Button>
          <div className="min-w-0">
            <p className="truncate font-medium leading-tight">{site.title}</p>
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-mono">{site.slug}</span>
              {' · кампаний: '}
              {state.campaigns.length}
              {' · активных: '}
              {running}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span
            className={`text-xs transition-opacity ${
              dirty ? 'text-warning opacity-100' : 'text-muted-foreground opacity-60'
            }`}
          >
            {dirty ? 'Есть несохранённые изменения' : 'Все изменения сохранены'}
          </span>
          <Button
            size="sm"
            variant={state.blocked ? 'destructive' : 'outline'}
            onClick={onToggleBlocked}
            disabled={pending}
            className={`press-scale gap-1.5 ${
              state.blocked
                ? ''
                : 'text-destructive hover:bg-destructive/10 hover:text-destructive'
            }`}
            title={
              state.blocked
                ? 'Витрина показывает белую страницу «Аккаунт заблокирован» — нажмите, чтобы снять блокировку'
                : 'Заменить весь контент витрины белой страницей «Аккаунт заблокирован»'
            }
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Ban className="size-4" />
            )}
            {state.blocked ? 'Снять блокировку' : 'Аккаунт заблокирован'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={onDownloadExtension}
            disabled={pending}
            className="press-scale gap-1.5"
            title="Собрать и скачать готовое расширение под этот сайт (токен постоянный — старые архивы продолжают работать)"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            Скачать расширение
          </Button>
          <Button
            size="sm"
            onClick={onSave}
            disabled={pending || !dirty}
            className="press-scale gap-1.5"
          >
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Сохранить всё
          </Button>
        </div>
      </div>

      {/* Blocked mode: loud persistent banner — the operator must never
          forget the vitrine is showing the white blocked screen while they
          quietly edit numbers nobody can see. */}
      {state.blocked && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3">
          <Ban className="size-4 shrink-0 text-destructive" />
          <p className="text-sm text-pretty">
            <span className="font-medium">Аккаунт заблокирован.</span>{' '}
            Витрина показывает белую страницу «Аккаунт заблокирован» вместо
            всего контента — правки ниже сохранятся, но не будут видны до
            снятия блокировки.
          </p>
        </div>
      )}

      {/* Version conflict: someone saved newer data while this editor was
          open. Offer an in-place reload (discards local edits) — the old
          flow forced closing and reopening the whole editor. */}
      {conflict && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
          <p className="text-sm text-pretty">
            <span className="font-medium">Конфликт версий.</span>{' '}
            Данные сайта изменились, пока редактор был открыт — сохранение
            отклонено, чтобы не затереть новое. Перезагрузка отбросит локальные
            правки — при необходимости сначала скопируйте черновик.
          </p>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard
                  .writeText(JSON.stringify(state, null, 2))
                  .then(() => toast.success('Черновик скопирован (JSON)'))
                  .catch(() => toast.error('Не удалось скопировать'))
              }}
              className="press-scale gap-1.5"
              title="Скопировать текущие несохранённые правки как JSON"
            >
              <ClipboardCopy className="size-4" />
              Скопировать черновик
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onReloadFresh}
              disabled={pending}
              className="press-scale gap-1.5"
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <RefreshCw className="size-4" />
              )}
              Перезагрузить данные
            </Button>
          </div>
        </div>
      )}
    </>
  )
}
