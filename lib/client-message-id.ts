/**
 * Idempotency key for composer sends (migration 163).
 *
 * The client mints one UUID per send ATTEMPT (not per keystroke, not per
 * conversation) and passes it to the send action. The server inserts the
 * message with `ON CONFLICT (conversation_id, client_message_id) DO NOTHING`,
 * so a retried action or a double tap resolves to the already-persisted row
 * and delivery is enqueued exactly once.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Mint a new key. Falls back to a random hex id where crypto.randomUUID is absent (old WebViews). */
export function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
    return crypto.randomUUID()
  // RFC 4122 v4 shape from Math.random — good enough as a dedupe key.
  const hex = () => Math.floor(Math.random() * 16).toString(16)
  const s = Array.from({ length: 32 }, hex)
  s[12] = '4'
  s[16] = ['8', '9', 'a', 'b'][Math.floor(Math.random() * 4)]
  const h = s.join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/**
 * Server-side validation: the column is UUID, so anything that is not a UUID
 * is dropped (→ no idempotency for that send, never a 500). Undefined stays
 * undefined so legacy callers without a key keep working.
 */
export function normalizeClientMessageId(
  raw: string | undefined | null,
): string | undefined {
  if (!raw) return undefined
  const v = raw.trim()
  return UUID_RE.test(v) ? v.toLowerCase() : undefined
}
