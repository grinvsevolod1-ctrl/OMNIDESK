/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * We use it to:
 *  - start the push dispatcher (lib/push-dispatcher) so inbound messages
 *    generate Web Push notifications regardless of whether a browser tab is
 *    open, and
 *  - resume the client simulator engine (lib/client-sim) if it was left
 *    enabled, so the QA bot keeps driving conversations in the background even
 *    when nobody has the god panel open.
 *
 * Guarded to the Node.js runtime so it never runs on the Edge runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return

  const { startPushDispatcher } = await import('./lib/push-dispatcher')
  startPushDispatcher()

  // Resume the simulator if it was enabled before the last restart. Best-effort:
  // never let a boot-time DB hiccup crash server startup.
  try {
    const { getSettings } = await import('./lib/client-sim/store')
    const settings = await getSettings()
    if (settings.enabled) {
      const { startEngine } = await import('./lib/client-sim/engine')
      startEngine()
    }
  } catch (err) {
    console.log(
      '[v0][client-sim] resume-on-boot skipped:',
      err instanceof Error ? err.message : String(err),
    )
  }
}
