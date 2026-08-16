import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

/**
 * Per-request correlation context (Node runtime only).
 *
 * A request id is threaded through all server work via AsyncLocalStorage so
 * every structured log line emitted while handling a request can be tied back
 * to that request (and to the `x-request-id` header echoed to the client),
 * without passing the id down through every function signature.
 *
 * Usage in a route handler:
 *   return runWithRequestContext(req, () => handler())
 * Anywhere deeper:
 *   log.info('scope', 'msg')   // requestId is attached automatically
 *   getRequestId()             // read it explicitly if needed
 */

export interface RequestContext {
  requestId: string
}

const storage = new AsyncLocalStorage<RequestContext>()

export const REQUEST_ID_HEADER = 'x-request-id'

/** Read the incoming request id, or generate a fresh one. */
export function resolveRequestId(headers: Headers | Request): string {
  const h = headers instanceof Request ? headers.headers : headers
  const incoming = h.get(REQUEST_ID_HEADER)?.trim()
  // Basic sanity cap so a client can't inject a huge value into every log line.
  if (incoming && incoming.length <= 200) return incoming
  return randomUUID()
}

/** Run `fn` inside a context carrying the given (or derived) request id. */
export function runWithRequestContext<T>(
  reqOrId: Request | string,
  fn: () => T,
): T {
  const requestId =
    typeof reqOrId === 'string' ? reqOrId : resolveRequestId(reqOrId)
  return storage.run({ requestId }, fn)
}

/** Current request id, or undefined when outside a request context. */
export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId
}

// Expose the getter on globalThis so the (edge-safe) structured logger can read
// the current request id WITHOUT importing node:async_hooks itself — this file
// is Node-only, but lib/server-log is bundled for the Edge runtime too.
;(globalThis as unknown as { __getRequestId?: () => string | undefined }).__getRequestId =
  getRequestId
