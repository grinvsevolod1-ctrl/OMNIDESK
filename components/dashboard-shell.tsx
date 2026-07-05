'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'
import {
  BarChart3,
  Bot,
  BookOpen,
  ChevronLeft,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  MessageSquareText,
  PanelLeft,
  Phone,
  Plug,
  Radio,
  Server,
  Settings,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { logoutAction } from '@/app/actions/auth'
import { BrandMark } from '@/components/brand'
import { Button } from '@/components/ui/button'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type NavIcon =
  | 'overview'
  | 'managers'
  | 'channels'
  | 'whatsapp'
  | 'connections'
  | 'inbox'
  | 'proxies'
  | 'livechat'
  | 'analytics'
  | 'quickReplies'
  | 'autopilot'
  | 'docs'
  | 'settings'

const ICONS: Record<NavIcon, LucideIcon> = {
  overview: LayoutDashboard,
  managers: Users,
  channels: Radio,
  whatsapp: Phone,
  connections: Plug,
  inbox: Inbox,
  proxies: Server,
  livechat: MessageCircle,
  analytics: BarChart3,
  quickReplies: MessageSquareText,
  autopilot: Bot,
  docs: BookOpen,
  settings: Settings,
}

export interface NavItem {
  href: string
  label: string
  icon: NavIcon
}

interface DashboardShellProps {
  nav: NavItem[]
  roleLabel: string
  user: { name: string; email: string }
  /** Optional control rendered in the header, before the user identity. */
  headerSlot?: ReactNode
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

function NavLinks({
  nav,
  pathname,
  collapsed,
  onNavigate,
}: {
  nav: NavItem[]
  pathname: string
  collapsed?: boolean
  onNavigate?: () => void
}) {
  return (
    <nav className="flex flex-col gap-1">
      {nav.map((item) => {
        const active =
          pathname === item.href || pathname.startsWith(item.href + '/')
        const Icon = ICONS[item.icon]
        const link = (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            aria-label={item.label}
            className={cn(
              'group relative flex items-center gap-2.5 rounded-lg text-sm font-medium transition-colors',
              collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
            )}
          >
            {active ? (
              <span
                className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-foreground"
                aria-hidden
              />
            ) : null}
            <Icon className="size-4 shrink-0" />
            {!collapsed ? item.label : null}
          </Link>
        )
        if (collapsed) {
          return (
            <Tooltip key={item.href}>
              <TooltipTrigger render={link} aria-label={item.label} />
              <TooltipContent side="right">{item.label}</TooltipContent>
            </Tooltip>
          )
        }
        return link
      })}
    </nav>
  )
}

export function DashboardShell({
  nav,
  roleLabel,
  user,
  headerSlot,
  children,
}: DashboardShellProps) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  // Полноэкранные страницы (инбокс) занимают всю доступную высоту без полей и
  // прокрутки страницы — скроллится только их внутреннее содержимое.
  const fullBleed = pathname.endsWith('/inbox')

  // Restore the collapsed preference on mount (client-only) to avoid a
  // hydration mismatch, then persist any change the user makes.
  useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSE_KEY) === '1')
    } catch {
      /* ignore */
    }
  }, [])

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
            collapsed ? 'w-16' : 'w-64',
          )}
        >
          <div
            className={cn(
              'flex h-14 items-center border-b border-sidebar-border',
              collapsed ? 'justify-center px-0' : 'gap-2 px-5',
            )}
          >
            <BrandMark className="size-5 shrink-0 text-foreground" />
            {!collapsed ? (
              <>
                <span className="text-sm font-semibold tracking-tight">
                  Omnidesk
                </span>
                <span className="ml-auto rounded-md border border-border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                  {roleLabel}
                </span>
              </>
            ) : null}
          </div>

          <div
            className={cn(
              'flex-1 overflow-y-auto py-3',
              collapsed ? 'px-2' : 'px-3',
            )}
          >
            <NavLinks nav={nav} pathname={pathname} collapsed={collapsed} />
          </div>

          {/* Collapse toggle */}
          <div
            className={cn(
              'border-t border-sidebar-border py-2',
              collapsed ? 'px-2' : 'px-3',
            )}
          >
            {collapsed ? (
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
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-4 backdrop-blur-md md:px-6">
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
                <Avatar className="size-7">
                  <AvatarFallback className="bg-secondary text-xs font-medium text-secondary-foreground">
                    {initials(user.name)}
                  </AvatarFallback>
                </Avatar>
                <span className="hidden max-w-[160px] flex-col leading-tight sm:flex">
                  <span className="truncate font-medium">{user.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {user.email}
                  </span>
                </span>
              </div>
              <form action={logoutAction}>
                <Button
                  type="submit"
                  variant="outline"
                  size="sm"
                  aria-label="Выйти"
                >
                  <LogOut className="size-4" />
                  <span className="hidden sm:inline">Выйти</span>
                </Button>
              </form>
            </div>
          </header>

          {fullBleed ? (
            <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
          ) : (
            <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 md:px-6 lg:px-8">
              <div className="mx-auto w-full max-w-6xl">{children}</div>
            </main>
          )}
        </div>
      </div>
    </TooltipProvider>
  )
}
