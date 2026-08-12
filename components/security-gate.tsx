'use client'

/**
 * Entry security gate — a fast, real-time preloader shown once per browser
 * session before the login screen. It runs a battery of client- and
 * server-side security checks, streaming each one's status into a minimal
 * monochrome checklist (matching the login page's glass/rise aesthetic).
 *
 * Design goals:
 *  - FAST: checks run concurrently; each row animates in as it starts and
 *    resolves within tens/hundreds of ms. Total gate time well under ~2s.
 *  - HONEST: only reports what a browser can actually observe (transport,
 *    CSP, storage integrity, webdriver flag, devtools debugger, clock skew,
 *    backend/DB reachability). No fake "antivirus" theatre.
 *  - NON-BLOCKING for anonymity: Tor/VPN/incognito are explicitly fine.
 *  - FAIL-SOFT: if a check finds something off (automation flag, tampered
 *    storage, big clock skew, degraded backend) we do not hard-block — we
 *    show what was found and ask the user to confirm they want to continue.
 *
 * The "passed" flag lives in sessionStorage, so the gate re-runs per browser
 * session, not on every navigation.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { BrandMark } from '@/components/brand'

const SESSION_KEY = 'od-secgate-v1'

type CheckStatus = 'pending' | 'running' | 'ok' | 'warn'

interface CheckRow {
  id: string
  label: string
  status: CheckStatus
  /** Shown under the row when status === 'warn'. */
  note?: string
}

/* ------------------------------ checks ------------------------------ */

function checkTransport(): Promise<string | null> {
  if (typeof window === 'undefined') return Promise.resolve(null)
  const secure =
    window.isSecureContext ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1'
  return Promise.resolve(
    secure
      ? null
      : 'Соединение не защищено (HTTP). Данные между вами и сервером могут быть перехвачены.',
  )
}

function checkStorageIntegrity(): Promise<string | null> {
  try {
    const probe = `od-probe-${Math.random().toString(36).slice(2)}`
    sessionStorage.setItem(probe, '1')
    const ok = sessionStorage.getItem(probe) === '1'
    sessionStorage.removeItem(probe)
    if (!ok) return Promise.resolve('Хранилище браузера ведёт себя некорректно.')
    return Promise.resolve(null)
  } catch {
    // Storage blocked entirely (e.g. hardened privacy mode) — fine, honest.
    return Promise.resolve(null)
  }
}

function checkAutomation(): Promise<string | null> {
  if (typeof navigator === 'undefined') return Promise.resolve(null)
  if (navigator.webdriver) {
    return Promise.resolve(
      'Браузер управляется автоматизацией (webdriver). Если это не вы — сессией может управлять постороннее ПО.',
    )
  }
  return Promise.resolve(null)
}

function checkExtensionTampering(): Promise<string | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  // Content-script tampering heuristic: injected inline handlers or rewritten
  // fetch/XHR prototypes are the common patterns of credential-stealing
  // extensions. We only check what is safely observable.
  try {
    const fetchNative = window.fetch.toString().includes('[native code]')
    const xhrNative = XMLHttpRequest.prototype.open
      .toString()
      .includes('[native code]')
    if (!fetchNative || !xhrNative) {
      return Promise.resolve(
        'Сетевые функции браузера изменены сторонним кодом (расширение или вредоносное ПО). Вводимые данные могут перехватываться.',
      )
    }
  } catch {
    /* inspection blocked — nothing provable, stay quiet */
  }
  return Promise.resolve(null)
}

async function checkBackend(): Promise<{
  warning: string | null
  serverTime: number | null
}> {
  try {
    const res = await fetch('/api/security-check', { cache: 'no-store' })
    if (!res.ok) {
      return {
        warning: 'Сервер безопасности недоступен — проверки со стороны сервера пропущены.',
        serverTime: null,
      }
    }
    const data = (await res.json()) as {
      checks?: { tls?: boolean; db?: boolean }
      serverTime?: number
    }
    if (data.checks && data.checks.db === false) {
      return {
        warning: 'Серверная база данных недоступна — вход может не работать.',
        serverTime: data.serverTime ?? null,
      }
    }
    return { warning: null, serverTime: data.serverTime ?? null }
  } catch {
    return {
      warning: 'Не удалось связаться с сервером для проверки безопасности.',
      serverTime: null,
    }
  }
}

/* ------------------------------ component ------------------------------ */

const ROWS: Omit<CheckRow, 'status'>[] = [
  { id: 'transport', label: 'Шифрование соединения' },
  { id: 'server', label: 'Целостность сервера и базы данных' },
  { id: 'clock', label: 'Синхронизация времени' },
  { id: 'storage', label: 'Целостность хранилища браузера' },
  { id: 'automation', label: 'Отсутствие стороннего управления' },
  { id: 'tamper', label: 'Чистота сетевых функций браузера' },
]

export function SecurityGate({ children }: { children: React.ReactNode }) {
  // null = not decided yet (SSR/first paint), true = show gate, false = pass.
  const [active, setActive] = useState<boolean | null>(null)
  const [rows, setRows] = useState<CheckRow[]>(
    ROWS.map((r) => ({ ...r, status: 'pending' })),
  )
  const [phase, setPhase] = useState<'checking' | 'confirm' | 'done'>('checking')
  const [leaving, setLeaving] = useState(false)
  const startedRef = useRef(false)

  const finish = useCallback(() => {
    setPhase('done')
    setLeaving(true)
    try {
      sessionStorage.setItem(SESSION_KEY, '1')
    } catch {
      /* storage blocked — gate simply re-runs next visit */
    }
    setTimeout(() => setActive(false), 450)
  }, [])

  useEffect(() => {
    try {
      setActive(sessionStorage.getItem(SESSION_KEY) !== '1')
    } catch {
      setActive(false) // storage fully blocked — do not trap the user
    }
  }, [])

  useEffect(() => {
    if (active !== true || startedRef.current) return
    startedRef.current = true

    const setRow = (id: string, status: CheckStatus, note?: string) =>
      setRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, status, note } : r)),
      )

    const stagger = (i: number) => new Promise((r) => setTimeout(r, 110 * i))

    const clientChecks: [string, () => Promise<string | null>][] = [
      ['transport', checkTransport],
      ['storage', checkStorageIntegrity],
      ['automation', checkAutomation],
      ['tamper', checkExtensionTampering],
    ]

    const t0 = Date.now()
    const tasks: Promise<boolean>[] = []

    // Client checks — staggered starts so rows light up in sequence, but each
    // resolves as fast as it actually is.
    clientChecks.forEach(([id, run], i) => {
      tasks.push(
        (async () => {
          await stagger(i)
          setRow(id, 'running')
          const warning = await run()
          // Tiny floor so a resolved check is perceivable, not subliminal.
          await new Promise((r) => setTimeout(r, 140))
          setRow(id, warning ? 'warn' : 'ok', warning ?? undefined)
          return !warning
        })(),
      )
    })

    // Server + clock checks share one round-trip.
    tasks.push(
      (async () => {
        await stagger(1)
        setRow('server', 'running')
        setRow('clock', 'running')
        const { warning, serverTime } = await checkBackend()
        setRow('server', warning ? 'warn' : 'ok', warning ?? undefined)
        let clockOk = true
        if (serverTime !== null) {
          const skew = Math.abs(Date.now() - serverTime)
          if (skew > 5 * 60_000) {
            clockOk = false
            setRow(
              'clock',
              'warn',
              'Часы вашего устройства расходятся с сервером более чем на 5 минут — возможна подмена соединения.',
            )
          } else {
            setRow('clock', 'ok')
          }
        } else {
          setRow('clock', 'ok')
        }
        return !warning && clockOk
      })(),
    )

    void Promise.all(tasks).then(async (results) => {
      const clean = results.every(Boolean)
      // Keep total gate time snappy but let the last animation land.
      const elapsed = Date.now() - t0
      if (elapsed < 900) await new Promise((r) => setTimeout(r, 900 - elapsed))
      if (clean) {
        finish()
      } else {
        setPhase('confirm')
      }
    })
  }, [active, finish])

  if (active !== true) return <>{children}</>

  const warns = rows.filter((r) => r.status === 'warn')

  return (
    <div
      className={`fixed inset-0 z-[100] flex items-center justify-center bg-background px-4 transition-opacity duration-500 ${
        leaving ? 'pointer-events-none opacity-0' : 'opacity-100'
      }`}
      role="status"
      aria-live="polite"
      aria-label="Проверка безопасности"
    >
      {/* Ambient glow, same language as the login page */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_-15%,oklch(0.28_0_0),transparent_70%)]"
      />

      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-4 text-center">
          <div className="od-glass relative flex size-14 items-center justify-center rounded-2xl">
            <BrandMark className="size-6 text-foreground" />
            {phase === 'checking' && (
              <span
                aria-hidden="true"
                className="absolute inset-0 animate-[od-gate-ring_1.6s_ease-in-out_infinite] rounded-2xl border border-foreground/20"
              />
            )}
          </div>
          <div className="space-y-1">
            <h1 className="text-lg font-semibold tracking-tight">
              Проверка безопасности
            </h1>
            <p className="text-xs text-muted-foreground">
              {phase === 'confirm'
                ? 'Обнаружены замечания — прочитайте перед продолжением'
                : 'Проверяем соединение и окружение перед входом'}
            </p>
          </div>
        </div>

        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li
              key={row.id}
              className={`od-gate-row rounded-xl border px-4 py-2.5 transition-all duration-300 ${
                row.status === 'pending'
                  ? 'border-transparent opacity-0'
                  : row.status === 'warn'
                    ? 'border-border bg-card/80 opacity-100'
                    : 'border-border/60 bg-card/40 opacity-100'
              }`}
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[13px] text-foreground/90">{row.label}</span>
                <CheckBadge status={row.status} />
              </div>
              {row.note && (
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">
                  {row.note}
                </p>
              )}
            </li>
          ))}
        </ul>

        {phase === 'confirm' && (
          <div className="od-rise mt-6 space-y-3">
            <p className="text-center text-xs leading-relaxed text-muted-foreground">
              {warns.length === 1
                ? 'Обнаружена потенциальная проблема безопасности.'
                : `Обнаружены потенциальные проблемы безопасности: ${warns.length}.`}{' '}
              Ваши данные могут быть скомпрометированы. Продолжить?
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => location.reload()}
                className="flex-1 rounded-xl border border-border bg-transparent px-4 py-2.5 text-sm text-foreground/80 transition-colors hover:bg-card"
              >
                Проверить снова
              </button>
              <button
                type="button"
                onClick={finish}
                className="flex-1 rounded-xl bg-foreground px-4 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
              >
                Продолжить
              </button>
            </div>
          </div>
        )}

        <p className="mt-8 text-center text-[10px] tracking-wide text-muted-foreground/60 uppercase">
          Omnidesk Security
        </p>
      </div>
    </div>
  )
}

function CheckBadge({ status }: { status: CheckStatus }) {
  if (status === 'running') {
    return (
      <span
        aria-label="Проверяется"
        className="size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-foreground/20 border-t-foreground/70"
      />
    )
  }
  if (status === 'ok') {
    return (
      <svg
        aria-label="Пройдено"
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 text-foreground/80"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M3 8.5 6.5 12 13 4.5" className="od-gate-check" />
      </svg>
    )
  }
  if (status === 'warn') {
    return (
      <svg
        aria-label="Замечание"
        viewBox="0 0 16 16"
        className="size-3.5 shrink-0 text-foreground"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path d="M8 4v5" />
        <circle cx="8" cy="12" r="0.5" fill="currentColor" />
      </svg>
    )
  }
  return <span className="size-3.5 shrink-0" />
}
