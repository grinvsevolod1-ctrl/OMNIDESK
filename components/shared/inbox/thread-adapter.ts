import type { Message, StickerItem } from '@/lib/types'

/**
 * Role adapter for the shared inbox core.
 *
 * The manager (`/app`) and the curator (`/curator/chats`) run the SAME thread
 * UI and the SAME optimistic-update logic; the only things that differ are
 * WHICH server actions get called (each role has its own, scoped by
 * `manager_id` / `curator_id` on the server) and the multipart upload route.
 * Everything role-specific is expressed through this interface, so a fix in
 * `use-message-actions.ts` / `use-thread-history.ts` / `thread-pane.tsx`
 * lands for both roles at once instead of having to be made twice.
 *
 * Adapters: `components/manager/inbox/manager-thread-adapter.ts` and
 * `components/curator/chats/curator-thread-adapter.ts`.
 */

export type ActionResult = { ok: boolean; message?: string }

export type VoiceAudio = { base64: string; mime: string; durationSec: number }

export type Base64File = { base64: string; mime: string; name: string }

export interface ThreadAdapter {
  /** Most-recent slice of a cold thread (one outside the SSR preload). */
  loadThread(
    conversationId: string,
  ): Promise<{ ok: boolean; messages: Message[] }>
  /** One more page of history strictly before `beforeIso`. */
  loadOlder(
    conversationId: string,
    beforeIso: string,
  ): Promise<{ ok: boolean; messages: Message[]; hasMore: boolean }>
  /**
   * Send text. `replyTo` is the quoted message (or null); the adapter decides
   * whether the channel supports quoting and routes accordingly.
   * `clientMessageId` is the per-attempt idempotency key (migration 163) — the
   * server dedupes on it, so a retried action never delivers twice.
   */
  send(
    conversationId: string,
    body: string,
    replyTo: Message | null,
    channelType: string,
    clientMessageId: string,
  ): Promise<ActionResult>
  edit(messageId: string, body: string): Promise<ActionResult>
  react(messageId: string, emoji: string): Promise<ActionResult>
  remove(messageId: string): Promise<ActionResult>
  forward(messageId: string, toConversationId: string): Promise<ActionResult>
  sendSticker(
    conversationId: string,
    sticker: StickerItem,
  ): Promise<ActionResult>
  sendVoice(conversationId: string, audio: VoiceAudio): Promise<ActionResult>
  schedule(
    conversationId: string,
    body: string,
    scheduleAtIso: string,
  ): Promise<ActionResult>
  /** Single Telegram photo/file via the MTProto worker job (base64 payload). */
  sendTelegramMedia(
    conversationId: string,
    file: Base64File,
    caption: string,
  ): Promise<ActionResult>
  /** Multipart upload route for WhatsApp/VK files, scoped to the role. */
  uploadRoute: string
}
