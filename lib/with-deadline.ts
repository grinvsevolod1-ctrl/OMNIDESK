/**
 * Race a promise against a wall-clock deadline.
 *
 * Shared by the panel and the worker (imported there as
 * `../../lib/with-deadline.js`). The point is to RELEASE THE CALLER: a media
 * request that waits on a stuck MTProto download, an unreachable object store
 * or a pool with no free connection must turn into an error the browser can act
 * on, not a request pending until the socket dies. The underlying work is not
 * cancelled — pass an AbortSignal alongside when the callee supports one.
 */
export class DeadlineError extends Error {
  readonly ms: number

  constructor(ms: number, label: string) {
    super(`${label} exceeded ${ms}ms`)
    this.name = 'DeadlineError'
    this.ms = ms
  }
}

export function isDeadlineError(err: unknown): err is DeadlineError {
  return err instanceof DeadlineError
}

export function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  label = 'operation',
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError(ms, label)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      },
    )
  })
}

/**
 * Positive integer from an env var, or the fallback. Used for the per-hop
 * media timeouts so an operator can tune them without a code change.
 */
export function envMs(name: string, fallback: number): number {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}
