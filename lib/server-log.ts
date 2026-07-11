import { randomUUID } from 'node:crypto'

export function logServerError(scope: string, error: unknown): string {
  const errorId = randomUUID()
  console.error(`[${scope}] ${errorId}`, error)
  return errorId
}

export function serverErrorResponse(scope: string, error: unknown): Response {
  const errorId = logServerError(scope, error)
  return Response.json(
    { ok: false, error: 'server_error', errorId },
    { status: 500 },
  )
}
