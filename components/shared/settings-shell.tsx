'use client'

/**
 * Единый шелл страницы настроек для всех трёх ролей: контент слева,
 * собственный сайдбар навигации СПРАВА (sticky, desktop) или горизонтальные
 * пилюли сверху (mobile). Вкладки переключаются мгновенно на клиенте:
 * все панели (включая серверные — health, audit) монтируются один раз и
 * прячутся через `hidden`, поэтому серверный контент не теряется и не
 * перезапрашивается. Активная вкладка синхронизирована с URL-хэшем
 * (#tab-id) — можно шарить прямую ссылку на раздел.
 *
 * Анимации — только transform/opacity (стандарт UI, AGENTS.md).
 */

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import {
  Activity,
  Bell,
  FileClock,
  Info,
  KeyRound,
  Settings2,
  ShieldCheck,
  User,
  UtensilsCrossed,
} from 'lucide-react'
import { cn } from '@/lib/utils'

/** Иконки по строковому имени: серверные страницы передают сериализуемые пропсы. */
const TAB_ICONS = {
  user: User,
  bell: Bell,
  key: KeyRound,
  shield: ShieldCheck,
  activity: Activity,
  'file-clock': FileClock,
  info: Info,
  lunch: UtensilsCrossed,
  settings: Settings2,
} as const

export type SettingsTabIcon = keyof typeof TAB_ICONS

export interface SettingsTab {
  id: string
  label: string
  /** Короткое пояснение под названием в сайдбаре. */
  hint: string
  icon: SettingsTabIcon
}

export function SettingsShell({
  tabs,
  panels,
  children,
}: {
  tabs: SettingsTab[]
  /** Панели по id вкладки. Серверные компоненты передаются как ReactNode. */
  panels: Record<string, ReactNode>
  /** Шапка над всей страницей (identity-карточка и т.п.), видна всегда. */
  children?: ReactNode
}) {
  const [active, setActive] = useState(tabs[0]?.id ?? '')

  // Диплинк: #tab-id открывает нужную вкладку при загрузке.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1)
    if (fromHash && tabs.some((t) => t.id === fromHash)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActive(fromHash)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function select(id: string) {
    setActive(id)
    // Хэш без прыжка скролла и без записи в историю на каждый клик.
    history.replaceState(null, '', `#${id}`)
  }

  // «Жидкая» подсветка активного пункта: одна пилюля ездит по сайдбару
  // transform-ом (GPU), как в dashboard-nav.
  const listRef = useRef<HTMLDivElement>(null)
  const activeIndex = useMemo(
    () => Math.max(0, tabs.findIndex((t) => t.id === active)),
    [tabs, active],
  )

  return (
    <div className="flex flex-col gap-6">
      {children}

      <div className="flex flex-col gap-6 lg:flex-row-reverse lg:items-start">
        {/* ── Сайдбар настроек (справа на desktop) ── */}
        <nav
          aria-label="Разделы настроек"
          className="shrink-0 lg:sticky lg:top-20 lg:w-64"
        >
          {/* Mobile: горизонтальные пилюли */}
          <div className="flex gap-1.5 overflow-x-auto pb-1 lg:hidden">
            {tabs.map((t) => {
              const Icon = TAB_ICONS[t.icon]
              const isActive = t.id === active
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => select(t.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors',
                    isActive
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground',
                  )}
                >
                  <Icon className="size-3.5" />
                  {t.label}
                </button>
              )
            })}
          </div>

          {/* Desktop: вертикальный список с ездящей подсветкой */}
          <div
            ref={listRef}
            className="relative hidden flex-col rounded-xl border border-border bg-card p-1.5 lg:flex"
          >
            {/* Ездящая пилюля: transform-only, высота строки фиксирована. */}
            <div
              aria-hidden
              className="absolute left-1.5 right-1.5 top-1.5 h-[3.25rem] rounded-lg bg-sidebar-accent transition-transform duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
              style={{ transform: `translateY(${activeIndex * 3.25}rem)` }}
            />
            {tabs.map((t) => {
              const Icon = TAB_ICONS[t.icon]
              const isActive = t.id === active
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => select(t.id)}
                  aria-current={isActive ? 'page' : undefined}
                  className={cn(
                    'relative z-10 flex h-[3.25rem] items-center gap-3 rounded-lg px-3 text-left transition-colors',
                    isActive
                      ? 'text-foreground'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <span
                    className={cn(
                      'flex size-8 shrink-0 items-center justify-center rounded-md border transition-colors',
                      isActive
                        ? 'border-primary/30 bg-primary/10 text-primary'
                        : 'border-border bg-muted/40',
                    )}
                  >
                    <Icon className="size-4" />
                  </span>
                  <span className="flex min-w-0 flex-col leading-tight">
                    <span className="truncate text-sm font-medium">
                      {t.label}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {t.hint}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        </nav>

        {/* ── Контент вкладок ── */}
        <div className="min-w-0 flex-1">
          {tabs.map((t) => (
            <section
              key={t.id}
              id={t.id}
              aria-label={t.label}
              // Все панели живут в DOM (серверный контент сохраняется);
              // активная проявляется лёгким fade+rise — transform/opacity only.
              className={cn(
                t.id === active
                  ? 'animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-out'
                  : 'hidden',
              )}
            >
              {panels[t.id] ?? null}
            </section>
          ))}
        </div>
      </div>
    </div>
  )
}

/** Карточка-«шапка» аккаунта над вкладками: аватар, имя, роль. */
export function SettingsIdentityCard({
  name,
  email,
  roleLabel,
}: {
  name: string
  email: string
  roleLabel: string
}) {
  const initials = name
    .split(' ')
    .map((p) => p[0])
    .filter(Boolean)
    .slice(0, 2)
    .join('')
    .toUpperCase()

  return (
    <div className="relative overflow-hidden rounded-xl border border-border bg-card">
      {/* Тонкая тонировка сверху — глубина без декоративного мусора. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-primary/[0.06] to-transparent"
      />
      <div className="relative flex items-center gap-4 p-5">
        <div className="flex size-14 shrink-0 items-center justify-center rounded-full bg-secondary text-lg font-semibold text-secondary-foreground">
          {initials}
        </div>
        <div className="min-w-0">
          <p className="truncate text-lg font-semibold">{name}</p>
          <p className="truncate text-sm text-muted-foreground">{email}</p>
        </div>
        <span className="ml-auto hidden shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3 py-1 text-xs font-medium text-primary sm:flex">
          <ShieldCheck className="size-3.5" />
          {roleLabel}
        </span>
      </div>
    </div>
  )
}
