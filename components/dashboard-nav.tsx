'use client'

/**
 * Sidebar navigation for the dashboard shell: icon registry, nav-item types,
 * active-route resolution and the NavLinks rail with the macOS-style sliding
 * highlight. Split out of dashboard-shell.tsx; the shell re-exports NavIcon /
 * NavItem so existing imports keep working.
 */
import Link from 'next/link'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  BarChart3,
  Bot,
  BookOpen,
  ChevronDown,
  Inbox,
  LayoutDashboard,
  MessageCircle,
  MessageSquareText,
  Plug,
  Radio,
  Server,
  ServerCog,
  Settings,
  BrainCircuit,
  Users,
  Wallet,
} from 'lucide-react'
import type { ComponentType } from 'react'
import {
  MaxIcon,
  TelegramIcon,
  TelemostIcon,
  VkIcon,
  WhatsappIcon,
} from '@/components/channel-icons'
import {
  Tooltip,
  TooltipContent,
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
  | 'servers'
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
  servers: ServerCog,
  livechat: MessageCircle,
  analytics: BarChart3,
  quickReplies: MessageSquareText,
  autopilot: Bot,
  ai: BrainCircuit,
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

export function NavLinks({
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
