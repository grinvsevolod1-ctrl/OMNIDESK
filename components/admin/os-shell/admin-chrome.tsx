'use client'

/**
 * Mode switch for the admin area. When the OS shell is enabled (default) the
 * /admin root becomes the OMNIDESK OS command shell; deeper routes
 * (/admin/managers, /admin/hosting, ...) keep the classic chrome so the
 * copilot can "open" them as apps and direct URLs keep working. When the
 * shell is disabled via the toggle cookie, everything renders classic and the
 * header shows a button to switch back.
 *
 * The decision is made server-side (cookie read in layout.tsx) and passed in
 * as a prop, so there is no flash of the wrong mode before hydration.
 */

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DashboardShell, type NavItem } from '@/components/dashboard-shell'
import type { Dictionaries } from '@/lib/dictionaries'
import type { ShellInsight } from '@/lib/admin-console/insights'
import type { AssistantTurn } from '@/lib/admin-console/assistant'
import { setShellModeAction } from '@/app/actions/admin-console'
import { OsShell } from './os-shell'

export function AdminChrome({
  shellEnabled,
  nav,
  user,
  dictionaries,
  insights = [],
  savedSession = null,
  children,
}: {
  shellEnabled: boolean
  nav: NavItem[]
  user: { name: string; email: string }
  dictionaries: Dictionaries
  insights?: ShellInsight[]
  savedSession?: AssistantTurn[] | null
  children: ReactNode
}) {
  const pathname = usePathname()

  // The shell replaces the DASHBOARD (root) only; deep routes stay classic so
  // the copilot can navigate into them.
  if (shellEnabled && pathname === '/admin') {
    return (
      <OsShell
        dictionaries={dictionaries}
        insights={insights}
        savedSession={savedSession}
      />
    )
  }

  const enableShell = async () => {
    try {
      await setShellModeAction(true)
    } catch {
      // Cookie deletion may still have applied; hard reload re-reads it.
    }
    // FULL page navigation instead of router.push + refresh: the client
    // Router Cache kept serving the classic RSC payload, so the button
    // «Включить OMNIDESK OS» appeared to do nothing.
    window.location.assign('/admin')
  }

  return (
    <DashboardShell
      nav={nav}
      roleLabel="Администратор"
      user={user}
      headerSlot={
        <Button
          variant="outline"
          size="sm"
          onClick={enableShell}
          className="gap-1.5"
        >
          <Terminal className="size-4" />
          <span className="hidden sm:inline">
            {shellEnabled ? 'OMNIDESK OS' : 'Включить OMNIDESK OS'}
          </span>
          <span className="sm:hidden">OS</span>
        </Button>
      }
    >
      {children}
    </DashboardShell>
  )
}
