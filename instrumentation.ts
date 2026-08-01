/**
 * Next.js instrumentation hook — runs once when the server process boots.
 *
 * Next.js compiles this file for BOTH the Node.js and Edge runtimes, so it must
 * NOT reference any Node-only API (process.on, process.exit, timers, the pg
 * pool) in its static body — doing so fails the build with "A Node.js API is
 * used … not supported in the Edge Runtime", even behind a runtime `if`.
 *
 * All the real startup work (push dispatcher, shutdown hooks) therefore lives
 * in ./instrumentation-node, which we import DYNAMICALLY only when running under
 * Node. The Edge bundle of this file stays free of Node APIs.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { registerNode } = await import('./instrumentation-node')
  await registerNode()
}
