import type { ReactNode } from 'react'
import { requireCurator } from '@/lib/auth'
import { logoutAction } from '@/app/actions/auth'
import { NotificationGate } from '@/components/manager/notification-gate'
import { NotificationProvider } from '@/components/manager/notification-provider'
import { Button } from '@/components/ui/button'

export default async function CuratorLayout({
  children,
}: {
  children: ReactNode
}) {
  const user = await requireCurator()

  return (
    <NotificationProvider>
      <div className="min-h-dvh bg-background text-foreground">
        <header className="border-b border-border">
          <div className="mx-auto flex h-14 max-w-3xl items-center justify-between gap-3 px-4">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">Менеджер по кадрам</p>
              <p className="truncate text-xs text-muted-foreground">
                {user.name}
                {user.email ? ` · ${user.email}` : ''}
              </p>
            </div>
            <form action={logoutAction}>
              <Button type="submit" variant="outline" size="sm">
                Выйти
              </Button>
            </form>
          </div>
        </header>
        <main>
          <NotificationGate>{children}</NotificationGate>
        </main>
      </div>
    </NotificationProvider>
  )
}
