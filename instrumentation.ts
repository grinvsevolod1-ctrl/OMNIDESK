/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * We use it to start the push dispatcher (lib/push-dispatcher) so inbound
 * messages generate Web Push notifications regardless of whether a browser tab
 * is open. Guarded to the Node.js runtime so it never runs on the Edge runtime.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startPushDispatcher } = await import('./lib/push-dispatcher')
  startPushDispatcher()
}
