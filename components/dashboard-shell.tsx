'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  BarChart3,
  Bot,
  BookOpen,
  ChevronDown,
  ChevronLeft,
  Inbox,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  MessageSquareText,
  PanelLeft,
  Plug,
  Radio,
  Server,
  Settings,
  Sparkles,
  Users,
  Wallet,
  X,
} from 'lucide-react'
import type { ComponentType } from 'react'
import { logoutAction } from '@/app/actions/auth'
import { BrandMark } from '@/components/brand'
import {
  MaxIcon,
  TelegramIcon,
  TelemostIcon,
  VkIcon,
  WhatsappIcon,
} from '@/components/channel-icons'
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
  | 'telegram'
  | 'vk'
  | 'max'
  | 'connections'
  | 'inbox'
  | 'proxies'
  | 'livechat'
  | 'analytics'
  | 'quickReplies'
  | 'autopilot'
  | 'ai'
  | 'telemost'
  | 'finance'
  | 'docs'
  | 'settings'

const ICONS: Record<NavIcon, ComponentType<{ className?: string }>> = {
  overview: LayoutDashboard,
  managers: Users,
  channels: Radio,
  whatsapp: WhatsappIcon,
  telegram: TelegramIcon,
  vk: VkIcon,
  max: MaxIcon,
  connections: Plug,
  inbox: Inbox,
  proxies: Server,
  livechat: MessageCircle,
  analytics: BarChart3,
  quickReplies: MessageSquareText,
  autopilot: Bot,
  ai: Sparkles,
  telemost: TelemostIcon,
  finance: Wallet,
  docs: BookOpen,
  settings: Settings,
}

export interface NavItem {
  href: string
  label: string
  icon: NavIcon
  /** When present, this item becomes a collapsible group of sub-links. */
  children?: NavItem[]
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

function collectHrefs(nav: NavItem[]): string[] {
  const out: string[] = []
  for (const item of nav) {
    out.push(item.href)
    if (item.children) for (const c of item.children) out.push(c.href)
  }
  return out
}

/**
 * Resolve the single active nav href using longest-prefix matching. This keeps
 * exactly one item highlighted even when hrefs nest (e.g. "/admin/accounts" vs
 * "/admin/accounts/telegram").
 */
function computeActiveHref(pathname: string, nav: NavItem[]): string | null {
  let best: string | null = null
  for (const href of collectHrefs(nav)) {
    if (pathname === href || pathname.startsWith(href + '/')) {
      if (!best || href.length > best.length) best = href
    }
  }
  return best
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
  const navRef = useRef<HTMLElement>(null)
  const activeRef = useRef<HTMLAnchorElement | null>(null)
  // Position/size of the sliding "liquid" highlight behind the active item.
  // Null until measured on the client so SSR doesn't render a misplaced pill.
  const [pill, setPill] = useState<{ top: number; height: number } | null>(null)
  // Which groups are expanded. A group auto-opens when it owns the active route.
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({})

  const activeHref = useMemo(
    () => computeActiveHref(pathname, nav),
    [pathname, nav],
  )
  const groupOwnsActive = (item: NavItem) =>
    !!item.children && item.children.some((c) => c.href === activeHref)

  // True when the active route lives inside a group the user has collapsed. In
  // the expanded rail its row is clipped to height 0, so the highlight must be
  // hidden entirely instead of floating at a stale offset (the "съезжает вниз
  // хотя вкладка закрыта" bug).
  const activeHiddenInGroup = useMemo(() => {
    if (collapsed) return false // collapsed rail flattens groups; child is shown
    for (const item of nav) {
      if (item.children?.some((c) => c.href === activeHref)) {
        const open = openGroups[item.href] ?? groupOwnsActive(item)
        return !open
      }
    }
    return false
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav, activeHref, openGroups, collapsed])

  // Auto-open the group that contains the active route whenever it changes.
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setOpenGroups((prev) => {
      const next = { ...prev }
      for (const item of nav) {
        if (item.children && item.children.some((c) => c.href === activeHref))
          next[item.href] = true
      }
      return next
    })
  }, [activeHref, nav])
  /* eslint-enable react-hooks/set-state-in-effect */

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    // Hide the pill outright when the active item is inside a collapsed group —
    // otherwise it would sit at the clipped (0-height) row's stale offset.
    if (activeHiddenInGroup) {
      setPill(null)
      return
    }

    let raf = 0
    let stopAt = 0

    function measure() {
      const nav = navRef.current
      const el = activeRef.current
      if (!nav || !el) {
        setPill(null)
        return
      }
      // Measure via bounding rects relative to the nav so the value is correct
      // even mid-transition (offsetTop can lag while parents animate height).
      const navRect = nav.getBoundingClientRect()
      const elRect = el.getBoundingClientRect()
      const top = elRect.top - navRect.top + nav.scrollTop
      setPill((prev) => {
        const next = { top, height: elRect.height }
        if (prev && prev.top === next.top && prev.height === next.height) {
          return prev
        }
        return next
      })
    }

    // Group expand/collapse and sidebar width both animate ~300ms; poll on rAF
    // for that window so the pill follows the item to its final resting place
    // instead of snapping to a pre-animation position (the "криво/не ту вкладку"
    // bugs). Then settle and stop.
    function tick() {
      measure()
      if (performance.now() < stopAt) {
        raf = requestAnimationFrame(tick)
      }
    }
    stopAt = performance.now() + 360
    tick()

    // Keep tracking on layout changes (font load, scrollbar, container resize).
    const ro = new ResizeObserver(() => measure())
    if (navRef.current) ro.observe(navRef.current)
    window.addEventListener('resize', measure)

    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
    // Re-run when the route changes, the sidebar collapses, or a group is
    // expanded/collapsed, so the highlight re-tracks from the new state.
  }, [pathname, collapsed, nav, openGroups, activeHiddenInGroup])
  /* eslint-enable react-hooks/set-state-in-effect */

  function renderLink(
    item: NavItem,
    opts?: { nested?: boolean; hidden?: boolean },
  ) {
    const active = item.href === activeHref
    const Icon = ICONS[item.icon]
    const link = (
      <Link
        key={item.href}
        href={item.href}
        ref={active && !opts?.hidden ? activeRef : undefined}
        onClick={onNavigate}
        aria-label={item.label}
        className={cn(
          'group relative z-10 flex items-center gap-2.5 rounded-lg text-sm font-medium transition-colors duration-200',
          collapsed ? 'justify-center px-0 py-2.5' : 'px-3 py-2',
          opts?.nested && !collapsed && 'py-1.5 text-[13px]',
          active
            ? 'text-sidebar-accent-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Icon
          className={cn(
            'size-4 shrink-0 transition-transform duration-200',
            active && 'scale-110',
          )}
        />
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
  }

  function renderGroup(item: NavItem) {
    const Icon = ICONS[item.icon]
    const sectionActive = groupOwnsActive(item)
    // Collapsed rail: no room for a disclosure, so flatten to tooltipped icons.
    if (collapsed) {
      return (
        <div key={item.href} className="flex flex-col gap-1">
          {item.children!.map((child) => renderLink(child))}
        </div>
      )
    }
    const open = openGroups[item.href] ?? sectionActive
    return (
      <div key={item.href} className="flex flex-col gap-1">
        <button
          type="button"
          onClick={() => setOpenGroups((p) => ({ ...p, [item.href]: !open }))}
          aria-expanded={open}
          className={cn(
            'group relative z-10 flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-colors duration-200',
            sectionActive
              ? 'text-foreground'
              : 'text-muted-foreground hover:text-foreground',
          )}
        >
          <Icon className="size-4 shrink-0" />
          {item.label}
          <ChevronDown
            className={cn(
              'ml-auto size-4 shrink-0 text-muted-foreground transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
              open && 'rotate-180',
            )}
          />
        </button>
        {/* Grid-rows trick animates height from 0 → auto smoothly. */}
        <div
          className={cn(
            'grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]',
            open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
          )}
        >
          <div className="overflow-hidden">
            <div className="ml-4 flex flex-col gap-1 border-l border-sidebar-border pl-2">
              {item.children!.map((child) =>
                renderLink(child, { nested: true, hidden: !open }),
              )}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <nav ref={navRef} className="relative flex flex-col gap-1">
      {/* macOS-style sliding highlight: a single element that springs between
          items instead of each item toggling its own background instantly. */}
      {pill ? (
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 z-0 rounded-lg bg-sidebar-accent transition-[transform,height] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
          style={{
            transform: `translateY(${pill.top}px)`,
            height: pill.height,
          }}
        />
      ) : null}
      {nav.map((item) =>
        item.children ? renderGroup(item) : renderLink(item),
      )}
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
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    </TooltipProvider>
  )
}
