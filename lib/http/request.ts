import { z } from 'zod'

export class HttpInputError extends Error {
  constructor(
    public readonly code: 'invalid_content_type' | 'invalid_json' | 'payload_too_large' | 'validation_error',
    public readonly status: 400 | 413 | 415 | 422,
  ) {
    super(code)
    this.name = 'HttpInputError'
  }
}

export async function readBodyBytes(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declaredLength = Number(request.headers.get('content-length'))
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new HttpInputError('payload_too_large', 413)
  }

  const bytes = new Uint8Array(await request.arrayBuffer())
  if (bytes.byteLength > maxBytes) {
    throw new HttpInputError('payload_too_large', 413)
  }
  return bytes
}

export function parseJsonBytes(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes))
  } catch {
    throw new HttpInputError('invalid_json', 400)
  }
}

export async function readJson<T>(
  request: Request,
  schema: z.ZodType<T>,
  maxBytes: number,
): Promise<T> {
  const contentType = request.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.startsWith('application/json')) {
    throw new HttpInputError('invalid_content_type', 415)
  }

  const bytes = await readBodyBytes(request, maxBytes)
  const value = parseJsonBytes(bytes)

  const parsed = schema.safeParse(value)
  if (!parsed.success) {
    throw new HttpInputError('validation_error', 422)
  }
  return parsed.data
}

export function inputErrorResponse(error: unknown): Response | null {
  if (!(error instanceof HttpInputError)) return null
  return Response.json({ ok: false, error: error.code }, { status: error.status })
}
