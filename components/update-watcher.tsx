'use client'

/**
 * Global update watcher: warns every open tab (managers, admin, god panel)
 * BEFORE an auto-deploy restarts the server, then reloads automatically once
 * the new build is live.
 *
 * How it works (see lib/build-id.ts for the server side):
 *  1. Polls /api/version every POLL_MS (plus immediately on tab refocus).
 *  2. First successful response pins the `runtime` id this page was served by.
 *  3. `disk !== runtime` → a new build was swapped in, restart imminent →
 *     full-screen "update installing" overlay + fast polling.
 *  4. `runtime` changes (new server process is up) → switch the overlay to
 *     "reloading" and hard-reload the page after a short beat.
 *  5. Fetch failures while installing = the server is restarting → keep the
 *     overlay up and keep polling until the new build answers.
 *
 * In dev both ids are 'dev', so the watcher never fires during development.
 */

import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'

const POLL_MS = 20_000
/** Faster cadence while an update is being installed / server restarting. */
const FAST_POLL_MS = 3_000
/** Give the "reloading" overlay a beat to paint before the hard reload. */
const RELOAD_DELAY_MS = 1_200
/**
 * Consecutive `disk !== runtime` observations required before showing the
 * "installing" overlay. A single mismatched poll can be a transient artifact
 * of the deploy swap window or a flaky read — never worth alarming users.
 */
const INSTALL_CONFIRM_POLLS = 2
/** sessionStorage key remembering which build id we already reloaded into. */
const RELOADED_FOR_KEY = 'od:update-reloaded-for'

type Phase = 'idle' | 'installing' | 'reloading'

export function UpdateWatcher() {
  const [phase, setPhase] = useState<Phase>('idle')

  useEffect(() => {
    let baseline: string | null = null
    let currentPhase: Phase = 'idle'
    let timer: ReturnType<typeof setTimeout> | null = null
    let disposed = false
    /** Consecutive polls that saw disk !== runtime (see INSTALL_CONFIRM_POLLS). */
    let diskMismatchStreak = 0

    const applyPhase = (next: Phase) => {
      if (currentPhase === next) return
      currentPhase = next
      setPhase(next)
    }

    const schedule = (ms: number) => {
      if (disposed) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => void check(), ms)
    }

    const check = async () => {
      if (disposed) return
      try {
        const res = await fetch('/api/version', { cache: 'no-store' })
        if (!res.ok) throw new Error(`status ${res.status}`)
        const data = (await res.json()) as { runtime?: string; disk?: string }
        const runtime = typeof data.runtime === 'string' ? data.runtime : null
        const disk = typeof data.disk === 'string' ? data.disk : null
        if (!runtime || runtime === 'dev') {
          schedule(POLL_MS)
          return
        }
        if (baseline === null) baseline = runtime

        if (runtime !== baseline) {
          // The NEW build is serving requests. Reload into it — but only ONCE
          // per build id: if we already reloaded for this exact id this
          // session, the backend is flapping between builds (e.g. a broken
          // deploy loop or mixed server instances), and reload-looping every
          // open tab would make the outage worse. Adopt it as the new
          // baseline and stay quiet instead.
          let alreadyReloadedFor: string | null = null
          try {
            alreadyReloadedFor = sessionStorage.getItem(RELOADED_FOR_KEY)
          } catch {
            /* sessionStorage unavailable (privacy mode) — fall through */
          }
          if (alreadyReloadedFor === runtime) {
            baseline = runtime
            diskMismatchStreak = 0
            applyPhase('idle')
            schedule(POLL_MS)
            return
          }
          try {
            sessionStorage.setItem(RELOADED_FOR_KEY, runtime)
          } catch {
            /* best-effort guard only */
          }
          applyPhase('reloading')
          if (timer) clearTimeout(timer)
          setTimeout(() => window.location.reload(), RELOAD_DELAY_MS)
          return
        }
        if (disk && disk !== runtime) {
          // Build swapped on disk, PM2 restart imminent. Require the mismatch
          // to persist across consecutive polls before alarming: a one-off
          // reading during the atomic swap window is not worth an overlay.
          diskMismatchStreak += 1
          if (diskMismatchStreak >= INSTALL_CONFIRM_POLLS) {
            applyPhase('installing')
          }
          schedule(FAST_POLL_MS)
          return
        }
        diskMismatchStreak = 0
        applyPhase('idle')
        schedule(POLL_MS)
      } catch {
        // Network error. If an install was in progress this IS the restart
        // window — keep the overlay and poll fast until the server returns.
        // Otherwise it's a normal transient blip: stay quiet.
        schedule(currentPhase === 'installing' ? FAST_POLL_MS : POLL_MS)
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    document.addEventListener('visibilitychange', onVisible)
    void check()

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  if (phase === 'idle') return null

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Обновление системы"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/80 p-6 backdrop-blur-sm"
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-border bg-card p-8 text-center shadow-2xl">
        <Loader2 className="size-8 animate-spin text-primary" />
        <div className="space-y-1.5">
          <p className="text-base font-semibold text-foreground">
            {phase === 'reloading'
              ? 'Обновление установлено'
              : 'Устанавливается обновление'}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {phase === 'reloading'
              ? 'Перезагружаем страницу…'
              : 'Пожалуйста, подождите. Страница обновится автоматически — ничего нажимать не нужно.'}
          </p>
        </div>
      </div>
    </div>
  )
}
