'use client'

import { useMemo, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Antenna,
  ArrowLeftRight,
  FlaskConical,
  Globe,
  MessagesSquare,
  Send,
  ServerCrash,
  ShieldCheck,
  Target,
  Lock,
  Users,
  type LucideIcon,
} from 'lucide-react'
import {
  secretLockAction,
  secretSetFake502Action,
  type ActionResult,
} from '@/app/actions/admin-secret'
import { Button, buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Channel, Manager } from '@/lib/types'
import type { SecretSystem } from '@/components/admin/secret-dashboard/types'
import {
  AiBalanceBanner,
  Confirm502Dialog,
} from '@/components/admin/secret-dashboard/system-cards'
import { ManagersTab } from '@/components/admin/secret-dashboard/managers-tab'
import { ChannelsTab } from '@/components/admin/secret-dashboard/channels-tab'
import { SecretTransferTab } from '@/components/admin/secret-transfer-tab'
import {
  SecretAdsTab,
  type SecretAdAccount,
} from '@/components/admin/secret-ads-tab'
import { SecretSitesTab } from '@/components/admin/secret-sites-tab'
import { SecretTelegramTab } from '@/components/admin/secret-telegram/telegram-tab'
import type { SiteListItem } from '@/app/actions/admin-secret'

type SectionId =
  | 'managers'
  | 'transfer'
  | 'channels'
  | 'telegram'
  | 'ads'
  | 'sites'
  | 'sites-beta'

const SECTIONS: {
  id: SectionId
  label: string
  short: string
  icon: LucideIcon
  desc: string
}[] = [
  {
    id: 'managers',
    label: 'Менеджеры',
    short: 'Люди',
    icon: Users,
    desc: 'Доступ, статусы и временные пароли',
  },
  {
    id: 'transfer',
    label: 'Передача',
    short: 'Передача',
    icon: ArrowLeftRight,
    desc: 'Перераспределение диалогов между менеджерами',
  },
  {
    id: 'channels',
    label: 'Каналы',
    short: 'Каналы',
    icon: Antenna,
    desc: 'Подключения, привязки и настройки каналов',
  },
  {
    id: 'telegram',
    label: 'Telegram',
    short: 'TG',
    icon: Send,
    desc: 'Личные Telegram-аккаунты и переписка',
  },
  {
    id: 'ads',
    label: 'Реклама',
    short: 'Реклама',
    icon: Target,
    desc: 'Рекламные кабинеты и метрики',
  },
  {
    id: 'sites',
    label: 'Сайты',
    short: 'Сайты',
    icon: Globe,
    desc: 'Управляемые внешние страницы-макеты',
  },
  {
    id: 'sites-beta',
    label: 'Сайты бета',
    short: 'Бета',
    icon: FlaskConical,
    desc: 'Те же сайты + сборка готового расширения в один клик',
  },
]

export function SecretDashboard({
  managers,
  curators,
  channels,
  system,
  adAccounts,
  sites,
  tgExclusive,
}: {
  managers: Manager[]
  /** HR-curator accounts (role='curator') — same temp-password controls. */
  curators: Manager[]
  channels: Channel[]
  system: SecretSystem
  adAccounts: SecretAdAccount[]
  /** Managed external sites (page3.html contract). */
  sites: SiteListItem[]
  /** Current value of the Telegram exclusive-session enforcement flag. */
  tgExclusive: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirm502Open, setConfirm502Open] = useState(false)
  const [section, setSection] = useState<SectionId>('managers')

  function run(action: () => Promise<ActionResult>, onDone?: () => void) {
    startTransition(async () => {
      try {
        const res = await action()
        if (res.ok) {
          toast.success(res.message)
          onDone?.()
        } else {
          toast.error(res.message)
        }
      } catch {
        toast.error('Внутренняя ошибка сервера')
      }
      router.refresh()
    })
  }

  const managerName = useMemo(() => {
    const map = new Map(managers.map((m) => [m.id, m.name]))
    return (id: string | null) => (id ? map.get(id) ?? '—' : '—')
  }, [managers])

  const active = SECTIONS.find((s) => s.id === section) ?? SECTIONS[0]

  function onToggle502() {
    if (system.fake502) {
      // Turning it OFF is safe — no confirmation needed.
      run(() => secretSetFake502Action(false))
    } else {
      setConfirm502Open(true)
    }
  }

  return (
    <div className="flex min-h-screen bg-background text-foreground">
      {/* ---- Desktop sidebar ---- */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 flex-col border-r border-border bg-card/40 md:flex">
        <div className="flex items-center gap-3 border-b border-border px-5 py-5">
          <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/50">
            <ShieldCheck className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">
              Супер-админ
            </p>
            <p className="truncate text-xs text-muted-foreground">
              Скрытая панель
            </p>
          </div>
        </div>

        <nav className="flex flex-1 flex-col gap-1 p-3">
          {SECTIONS.map((s) => (
            <SideNavItem
              key={s.id}
              icon={s.icon}
              label={s.label}
              active={s.id === section}
              onClick={() => setSection(s.id)}
            />
          ))}
        </nav>

        {system.gateEnabled && (
          <div className="flex flex-col gap-2 border-t border-border p-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void secretLockAction().then(() => router.refresh())}
              className="press-scale w-full justify-start gap-2"
            >
              <Lock className="size-4" />
              Заблокировать панель
            </Button>
          </div>
        )}
      </aside>

      {/* ---- Main column ---- */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Top toolbar */}
        <header className="sticky top-0 z-20 border-b border-border bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
          <div className="flex flex-col gap-3 p-4 md:flex-row md:items-center md:justify-between md:px-8 md:py-5">
            <div className="flex items-center gap-3">
              <div className="flex size-10 items-center justify-center rounded-xl border border-border bg-muted/40 md:hidden">
                <active.icon className="size-5" />
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold tracking-tight md:text-xl">
                  {active.label}
                </h1>
                <p className="truncate text-xs text-muted-foreground md:text-sm">
                  {active.desc}
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Link
                href="/wijegniwjgwjog/messages"
                className={cn(
                  buttonVariants({ variant: 'default', size: 'sm' }),
                  'gap-1.5',
                )}
                title="Открыть мессенджер — диалоги от имени клиента"
              >
                <MessagesSquare className="size-4" />
                <span className="hidden sm:inline">Мессенджер</span>
              </Link>
              <Button
                variant={system.fake502 ? 'destructive' : 'outline'}
                size="sm"
                onClick={onToggle502}
                disabled={pending}
                className={cn(
                  'press-scale gap-1.5',
                  !system.fake502 &&
                    'border-destructive/40 text-destructive hover:text-destructive',
                )}
                title={
                  system.fake502
                    ? 'Сейчас админы и менеджеры видят 502 — нажмите, чтобы выключить'
                    : 'Показать админам и менеджерам экран 502 Bad Gateway'
                }
              >
                <ServerCrash className="size-4" />
                {system.fake502 ? '502 вкл' : '502'}
              </Button>
            </div>
          </div>

          {/* Mobile lock button (desktop shows it in the sidebar) */}
          {system.gateEnabled && (
            <div className="flex items-center px-4 pb-3 md:hidden">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  void secretLockAction().then(() => router.refresh())
                }
                className="press-scale ml-auto gap-1.5"
              >
                <Lock className="size-4" />
                Блок
              </Button>
            </div>
          )}
        </header>

        {/* Content */}
        <main className="flex-1 space-y-5 p-4 pb-24 md:p-8 md:pb-8">
          <AiBalanceBanner system={system} />

          {section === 'managers' && (
            <ManagersTab
              managers={managers}
              curators={curators}
              pending={pending}
              run={run}
            />
          )}
          {section === 'transfer' && <SecretTransferTab managers={managers} />}
          {section === 'channels' && (
            <ChannelsTab
              channels={channels}
              managers={managers}
              managerName={managerName}
              pending={pending}
              run={run}
              tgExclusive={tgExclusive}
            />
          )}
          {section === 'telegram' && <SecretTelegramTab />}
          {section === 'ads' && <SecretAdsTab accounts={adAccounts} />}
          {section === 'sites' && <SecretSitesTab sites={sites} />}
          {section === 'sites-beta' && (
            <SecretSitesTab sites={sites} beta />
          )}
        </main>
      </div>

      {/* ---- Mobile bottom nav ---- */}
      <nav className="fixed inset-x-0 bottom-0 z-30 flex border-t border-border bg-card/95 backdrop-blur md:hidden">
        {SECTIONS.map((s) => (
          <BottomNavItem
            key={s.id}
            icon={s.icon}
            label={s.short}
            active={s.id === section}
            onClick={() => setSection(s.id)}
          />
        ))}
      </nav>

      <Confirm502Dialog
        open={confirm502Open}
        onOpenChange={setConfirm502Open}
        pending={pending}
        onConfirm={() =>
          run(() => secretSetFake502Action(true), () => setConfirm502Open(false))
        }
      />
    </div>
  )
}

/* ------------------------------ Navigation ------------------------------ */

function SideNavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'press-scale flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors',
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
      )}
    >
      <Icon className="size-5 shrink-0" />
      {label}
    </button>
  )
}

function BottomNavItem({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: LucideIcon
  label: string
  active: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex flex-1 flex-col items-center gap-1 py-2.5 text-[0.7rem] font-medium transition-colors',
        active ? 'text-primary' : 'text-muted-foreground',
      )}
    >
      <span
        className={cn(
          'flex h-8 w-12 items-center justify-center rounded-full transition-colors',
          active && 'bg-primary/10',
        )}
      >
        <Icon className="size-5" />
      </span>
      {label}
    </button>
  )
}
