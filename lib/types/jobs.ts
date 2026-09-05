export type JobAction =
  | 'start'
  // One-button QR login (Telegram): auth.exportLoginToken, no phone/SMS. The
  // owner scans the QR from Telegram → Settings → Devices.
  | 'start_qr'
  | 'stop'
  | 'restart'
  | 'logout'
  | 'send_code'
  | 'send_password'
  | 'send_message'
  // Send a sticker (Telegram only) by its document descriptor.
  | 'send_sticker'
  // Send a voice note recorded in the panel composer (payload: base64 audio).
  | 'send_voice'
  // Send a photo/document from the composer (payload: base64 file + caption).
  // One job per file; a multi-photo batch enqueues several send_file jobs.
  | 'send_file'
  // Telegram-only message actions: react with an emoji, delete (revoke),
  // edit the text of an already-sent message, and forward to another chat.
  | 'react_message'
  | 'delete_message'
  | 'edit_message'
  | 'forward_message'
  // Soft pause: keep the session connected but stop writing inbound to the
  // inbox (pause), then resume inbound persistence (resume).
  | 'pause'
  | 'resume'
  // Send read receipts for a chat so the contact sees we read their messages.
  | 'mark_read'
  // Show the native "typing…" action to the contact (Telegram only).
  | 'set_typing'
  // God-panel manual trigger: immediately terminate all foreign Telegram
  // authorizations on the channel's account, regardless of the exclusive-session
  // toggle state. One-shot, fired on demand.
  | 'kick_foreign_sessions'

export type JobStatus = 'queued' | 'running' | 'done' | 'error'

export interface ChannelJob {
  id: string
  channelId: string
  /** Owning manager, or null for system/admin-initiated jobs (e.g. God-panel). */
  managerId: string | null
  action: JobAction
  payload: Record<string, unknown>
  status: JobStatus
  result: Record<string, unknown> | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}
