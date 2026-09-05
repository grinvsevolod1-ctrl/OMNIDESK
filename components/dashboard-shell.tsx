'use client'

/**
 * Application chrome shared by all three roles: desktop sidebar (collapsible),
 * mobile drawer, header with user identity and logout, and the routed main
 * column. The navigation rail itself (icons, types, sliding highlight) lives
 * in dashboard-nav.tsx; NavIcon/NavItem are re-exported for compatibility.
 */
import { usePathname } from 'next/navigation'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ChevronLeft, Loader2, LogOut, Menu, PanelLeft, X } from 'lucide-react'
import { logoutAction } from '@/app/actions/auth'
import { updateMyAvatarAction } from '@/app/actions/account'
import type { SimpleResult } from '@/app/actions/account-shared'
import { unsubscribePushThisDevice } from '@/lib/push-client'
import { AvatarPickerDialog } from '@/components/shared/avatar-picker'
import { BrandMark } from '@/components/brand'
import { NavLinks } from '@/components/dashboard-nav'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type { NavIcon, NavItem } from '@/components/dashboard-nav'
import type { NavItem } from '@/components/dashboard-nav'

interface DashboardShellProps {
  nav: NavItem[]
  roleLabel: string
  user: { name: string; email: string; avatarUrl?: string | null }
  /** Optional control rendered in the header, before the user identity. */
  headerSlot?: ReactNode
  /**
   * Serverное сохранение аватарки из шапки. По умолчанию — для ролей из
   * managers; админ передаёт updateAdminAvatarAction (у него нет строки в БД).
   */
  avatarAction?: (value: string | null) => Promise<SimpleResult>
  children: ReactNode
}

const COLLAPSE_KEY = 'omnidesk:sidebar-collapsed'

function initials(name: string): string {
  return name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()
}

export function DashboardShell({
  nav,
  roleLabel,
  user,
  headerSlot,
  avatarAction = updateMyAvatarAction,
  children,
}: DashboardShellProps) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const [avatarUrl, setAvatarUrl] = useState<string | null>(
    user.avatarUrl ?? null,
  )
  const [avatarPickerOpen, setAvatarPickerOpen] = useState(false)

  // Sign out cleanly: drop THIS device's push subscription BEFORE ending the
  // session, otherwise the server row survives and the dispatcher keeps pushing
  // to a logged-out device. Cleanup is best-effort and never blocks logout.
  const handleLogout = useCallback(async () => {
    setLoggingOut(true)
    try {
      await unsubscribePushThisDevice()
    } finally {
      await logoutAction()
    }
  }, [])
  // Временный фокус-режим (навигация по кружкам/фото в инбоксе): сайдбар
  // сворачивается на время, НЕ трогая сохранённое предпочтение пользователя,
  // и разворачивается обратно, когда режим выключается.
  const [focusMode, setFocusMode] = useState(false)

  // Полноэкранные страницы (инбокс) занимают всю доступную высоту без полей и
  // прокрутки страницы — скроллится только их внутреннее содержимое.
  const fullBleed = pathname.endsWith('/inbox') || pathname.endsWith('/curator/chats')

  // Restore the collapsed preference on mount (client-only) to avoid a
  // hydration mismatch, then persist any change the user makes.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {
      /* ignore */
    }
  }, [])

  // Пока смонтирована оболочка дашборда, документ скроллиться не должен:
  // прокручивается только <main>. Без этого временное переполнение при
  // загрузке (порталы тостов, графики до гидрации) позволяло проскроллить
  // body ниже h-dvh-оболочки — оставался «чёрный подвал» под контентом.
  useEffect(() => {
    const html = document.documentElement
    const prev = html.style.overflow
    html.style.overflow = 'clip'
    window.scrollTo(0, 0)
    return () => {
      html.style.overflow = prev
    }
  }, [])

  useEffect(() => {
    const onFocusMode = (e: Event) => {
      const detail = (e as CustomEvent<{ active?: boolean }>).detail
      setFocusMode(Boolean(detail?.active))
    }
    window.addEventListener('omnidesk:focus-mode', onFocusMode)
    return () => window.removeEventListener('omnidesk:focus-mode', onFocusMode)
  }, [])

  // Открытая карточка лида сворачивает сайдбар так же, как фокус-режим:
  // временно (сохранённое предпочтение пользователя не трогаем) — чтобы
  // правая панель карточки не перекрывала контент диалога. При закрытии
  // карточки сайдбар возвращается в исходное состояние.
  const [leadCardOpen, setLeadCardOpen] = useState(false)
  useEffect(() => {
    const onLeadCard = (e: Event) => {
      const detail = (e as CustomEvent<{ open?: boolean }>).detail
      setLeadCardOpen(Boolean(detail?.open))
    }
    window.addEventListener('omnidesk:lead-card-open', onLeadCard)
    return () =>
      window.removeEventListener('omnidesk:lead-card-open', onLeadCard)
  }, [])

  const effectiveCollapsed = collapsed || focusMode || leadCardOpen

  function toggleCollapsed() {
    setCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  return (
    <TooltipProvider>
      <div className="flex h-dvh overflow-hidden bg-background">
        {/* Desktop sidebar */}
        <aside
          className={cn(
            'hidden shrink-0 flex-col border-r border-sidebar-border bg-sidebar transition-[width] duration-200 ease-out lg:flex',
            effectiveCollapsed ? 'w-16' : 'w-64',
          )}
        >
          <div
            className={cn(
              'flex h-14 items-center border-b border-sidebar-border',
              effectiveCollapsed ? 'justify-center px-0' : 'gap-2 px-5',
            )}
          >
            <BrandMark className="size-5 shrink-0 text-foreground" />
            {!effectiveCollapsed ? (
              // Роль — второй строкой под логотипом: длинные названия
              // («Менеджер по кадрам») не ломают шапку переносом бейджа.
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="truncate text-sm font-semibold tracking-tight">
                  Omnidesk
                </span>
                <span className="truncate text-[10px] font-medium uppercase tracking-widest text-muted-foreground">
                  {roleLabel}
                </span>
              </span>
            ) : null}
          </div>

          <div
            className={cn(
              'flex-1 overflow-y-auto py-3',
              effectiveCollapsed ? 'px-2' : 'px-3',
            )}
          >
            <NavLinks
              nav={nav}
              pathname={pathname}
              collapsed={effectiveCollapsed}
            />
          </div>

          {/* Collapse toggle */}
          <div
            className={cn(
              'border-t border-sidebar-border py-2',
              effectiveCollapsed ? 'px-2' : 'px-3',
            )}
          >
            {effectiveCollapsed ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      onClick={toggleCollapsed}
                      aria-label="Развернуть панель"
                      className="flex w-full items-center justify-center rounded-lg py-2.5 text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
                    >
                      <PanelLeft className="size-4" />
                    </button>
                  }
                />
                <TooltipContent side="right">Развернуть панель</TooltipContent>
              </Tooltip>
            ) : (
              <button
                type="button"
                onClick={toggleCollapsed}
                className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
              >
                <ChevronLeft className="size-4 shrink-0" />
                Свернуть панель
              </button>
            )}
          </div>
        </aside>

        {/* Mobile drawer */}
        {mobileOpen ? (
          <div className="fixed inset-0 z-50 lg:hidden">
            <div
              className="absolute inset-0 bg-black/60"
              onClick={() => setMobileOpen(false)}
              aria-hidden="true"
            />
            <aside className="absolute left-0 top-0 flex h-full w-72 max-w-[80%] flex-col border-r border-sidebar-border bg-sidebar">
              <div className="flex h-14 items-center gap-2 border-b border-sidebar-border px-5">
                <BrandMark className="size-5 text-foreground" />
                <span className="text-sm font-semibold tracking-tight">
                  Omnidesk
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  onClick={() => setMobileOpen(false)}
                  aria-label="Закрыть меню"
                >
                  <X className="size-4" />
                </Button>
              </div>
              <div className="flex-1 overflow-y-auto p-3">
                <NavLinks
                  nav={nav}
                  pathname={pathname}
                  onNavigate={() => setMobileOpen(false)}
                />
              </div>
            </aside>
          </div>
        ) : null}

        {/* Main column */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Без backdrop-blur: пере-блюр контента под sticky-шапкой на каждом
              кадре скролла — источник глюков (см. стандарт UI в AGENTS.md). */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background px-4 md:px-6">
            <Button
              variant="ghost"
              size="icon-sm"
              className="lg:hidden"
              onClick={() => setMobileOpen(true)}
              aria-label="Открыть меню"
            >
              <Menu className="size-4" />
            </Button>

            <div className="ml-auto flex items-center gap-2">
              {headerSlot}
              <div className="flex items-center gap-2 rounded-lg px-1.5 py-1 text-sm">
                <button
                  type="button"
                  onClick={() => setAvatarPickerOpen(true)}
                  aria-label="Изменить аватар"
                  className="group relative rounded-full focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Avatar className="size-7">
                    {avatarUrl ? (
                      <AvatarImage src={avatarUrl} alt={user.name} />
                    ) : null}
                    <AvatarFallback className="bg-secondary text-xs font-medium text-secondary-foreground">
                      {initials(user.name)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="absolute inset-0 rounded-full ring-1 ring-inset ring-transparent transition group-hover:ring-primary" />
                </button>
                <span className="hidden max-w-[160px] flex-col leading-tight sm:flex">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </span>
              </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label="Выйти"
            disabled={loggingOut}
            onClick={() => void handleLogout()}
          >
            {loggingOut ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <LogOut className="size-4" />
            )}
            <span className="hidden sm:inline">Выйти</span>
          </Button>
            </div>
          </header>

          {fullBleed ? (
            <main className="min-h-0 flex-1 overflow-hidden">
              {/* Keyed on the route so switching tabs replays a quick fade —
                  the full-bleed inbox keeps its own height, so fade only. */}
              <div
                key={pathname}
                className="flex h-full min-h-0 flex-col animate-in fade-in-0 duration-200 ease-out"
              >
                {children}
              </div>
            </main>
          ) : (
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 lg:px-8">
              {/* macOS-style page transition: fast fade + subtle rise, replayed
                  on every route change via the pathname key. */}
              <div
                key={pathname}
                className="mx-auto w-full max-w-6xl animate-in fade-in-0 slide-in-from-bottom-2 duration-300 ease-out"
              >
                {children}
              </div>
            </main>
          )}
        </div>
      </div>

      <AvatarPickerDialog
        open={avatarPickerOpen}
        onOpenChange={setAvatarPickerOpen}
        currentAvatar={avatarUrl}
        action={avatarAction}
        onSaved={setAvatarUrl}
      />
    </TooltipProvider>
  )
}
