import 'server-only'
import { query } from './db'

/**
 * Lead-conversion confirmation webhook.
 *
 * Business rule: a lead is considered "converted" the moment the visitor
 * receives their FIRST reply in a conversation (a manager's first answer, or an
 * autopilot auto-reply — both flow through `addMessage`). At that point we POST
 * to an external endpoint, passing the order code the client included in their
 * very first message (e.g. "Код заявки: A7K4M2").
 *
 * Delivery is fire-and-forget from the caller's perspective but exactly-once
 * per conversation: we atomically claim the conversion via `conversion_sent_at`
 * before sending, and reset it on failure so the next outbound message retries.
 */

/**
 * Order codes use a deliberately ambiguity-free alphabet:
 *   ABCDEFGHJKLMNPQRSTUVWXYZ23456789  (no 0/O, no 1/I)
 * i.e. uppercase letters except I and O, plus digits 2–9. Always 6 chars.
 */
const CODE_CHARSET = 'A-HJ-NP-Z2-9'
const STANDALONE_CODE = new RegExp(`\\b([${CODE_CHARSET}]{6})\\b`, 'g')
// Prefer a code that directly follows a "код заявки" / "заявка" / "код" label.
const LABELLED_CODE = new RegExp(
  `(?:код\\s*заявки|заявк\\w*|код)\\s*[:#№-]?\\s*([${CODE_CHARSET}]{6})\\b`,
  'i',
)

/** A 6-char code looks like a real order code when it mixes letters + digits. */
function looksLikeCode(candidate: string): boolean {
  return /[A-Z]/.test(candidate) && /[2-9]/.test(candidate)
}

/**
 * Extract the order code from a piece of client text. Returns the uppercase
 * code or null. A custom matcher can be supplied via the
 * `LEADS_CONFIRM_CODE_REGEX` env var (first capture group, or whole match).
 */
export function extractLeadCode(text: string | null | undefined): string | null {
  if (!text) return null

  const override = (process.env.LEADS_CONFIRM_CODE_REGEX || '').trim()
  if (override) {
    try {
      const re = new RegExp(override, 'i')
      const m = re.exec(text)
      if (m) return (m[1] ?? m[0]).toUpperCase()
    } catch {
      // Fall through to the built-in matchers on a bad pattern.
    }
  }

  // 1) Labelled form wins — most reliable, tolerates surrounding prose.
  const labelled = LABELLED_CODE.exec(text)
  if (labelled?.[1]) return labelled[1].toUpperCase()

  // 2) Otherwise, the first standalone token that mixes letters and digits.
  STANDALONE_CODE.lastIndex = 0
  for (let m = STANDALONE_CODE.exec(text); m; m = STANDALONE_CODE.exec(text)) {
    if (looksLikeCode(m[1])) return m[1].toUpperCase()
  }
  return null
}

interface ClaimRow {
  contact_handle: string
  contact_name: string
  channel_id: string
  channel_type: string
  lead_code: string | null
}

/**
 * Fire the conversion webhook for `conversationId` if it hasn't fired yet.
 * Safe to call on every outbound message — it self-guards via
 * `conversion_sent_at` and no-ops when no webhook URL is configured.
 *
 * Scoped to `managerId` so a manager can only trigger conversions on their own
 * conversations.
 */
export async function notifyLeadConversionOnFirstReply(
  conversationId: string,
  managerId: string,
): Promise<void> {
  const url = (process.env.LEADS_CONFIRM_WEBHOOK_URL || '').trim()
  if (!url) return // Feature disabled until an endpoint is configured.

  // Atomically claim the conversion: only one caller wins the transition from
  // NULL → now(), guaranteeing the webhook fires exactly once per conversation.
  const claimed = await query<ClaimRow>(
    `UPDATE conversations
        SET conversion_sent_at = now()
      WHERE id = $1
        AND manager_id = $2
        AND conversion_sent_at IS NULL
      RETURNING contact_handle, contact_name, channel_id, channel_type, lead_code`,
    [conversationId, managerId],
  )
  if (claimed.length === 0) return // Already sent (or not owned by this manager).

  const row = claimed[0]
  try {
    // Resolve the order code: use the cached value, else parse it out of the
    // client's inbound messages (oldest first) and cache it.
    let code = row.lead_code
    if (!code) {
      const inbound = await query<{ body: string }>(
        `SELECT body FROM messages
          WHERE conversation_id = $1 AND direction = 'in'
          ORDER BY created_at ASC`,
        [conversationId],
      )
      for (const msg of inbound) {
        const found = extractLeadCode(msg.body)
        if (found) {
          code = found
          break
        }
      }
      if (code) {
        await query('UPDATE conversations SET lead_code = $2 WHERE id = $1', [
          conversationId,
          code,
        ])
      }
    }

    const secret = (process.env.LEADS_CONFIRM_WEBHOOK_SECRET || '').trim()
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-webhook-secret': secret } : {}),
      },
      body: JSON.stringify({
        code: code ?? null,
      }),
      // Don't let a slow endpoint hang the reply path.
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      throw new Error(`Webhook responded ${res.status}`)
    }
  } catch (err) {
    // Delivery failed — release the claim so the next outbound message retries.
    await query(
      'UPDATE conversations SET conversion_sent_at = NULL WHERE id = $1',
      [conversationId],
    ).catch(() => {})
    console.error(
      `lead conversion webhook failed for ${conversationId}:`,
      err instanceof Error ? err.message : String(err),
    )
  }
}
