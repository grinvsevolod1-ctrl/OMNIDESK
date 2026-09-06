/**
 * Support tickets (see migration 167). Any authenticated staff member can open
 * a ticket from the header — a bug report or an improvement suggestion — with a
 * text description and any number of screenshot/video attachments. Each ticket
 * is persisted here for history AND forwarded to the owner's Telegram bot (the
 * same deploy-notification bot: TELEGRAM_ALERT_BOT_TOKEN / TELEGRAM_ALERT_CHAT_ID).
 * Attachment BYTES are not stored in the DB — they are forwarded to Telegram;
 * we keep only lightweight metadata (name/size/type) for later triage.
 */

import { query } from '@/lib/db'

export type SupportKind = 'problem' | 'suggestion'
export type SupportDelivery = 'sent' | 'partial' | 'failed' | 'not_configured'

export interface SupportAttachmentMeta {
  name: string
  size: number
  type: string
  /** Whether the file was actually forwarded to Telegram (size within limits). */
  forwarded: boolean
}

export interface RecordSupportTicketInput {
  kind: SupportKind
  authorSub: string
  authorName: string
  authorEmail: string
  authorRole: string
  description: string
  attachments: SupportAttachmentMeta[]
  delivery: SupportDelivery
}

/** Persist a support ticket. Returns the new row id. */
export async function recordSupportTicket(
  input: RecordSupportTicketInput,
): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO support_tickets
       (kind, author_sub, author_name, author_email, author_role,
        description, attachments, delivery)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
     RETURNING id`,
    [
      input.kind,
      input.authorSub,
      input.authorName,
      input.authorEmail,
      input.authorRole,
      input.description,
      JSON.stringify(input.attachments),
      input.delivery,
    ],
  )
  return rows[0].id
}
