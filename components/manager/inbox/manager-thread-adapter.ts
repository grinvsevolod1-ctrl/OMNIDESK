import {
  sendMessageAction,
  sendScheduledMessageAction,
  sendStickerAction,
  sendVoiceAction,
} from '@/app/actions/account'
import {
  deleteMessageAction,
  editMessageAction,
  forwardMessageAction,
  loadOlderMessagesAction,
  loadThreadMessagesAction,
  reactMessageAction,
  replyMessageAction,
} from '@/app/actions/messages'
import { sendTelegramMediaAction } from '@/app/actions/account-media'
import type { ThreadAdapter } from '@/components/shared/inbox/thread-adapter'

/**
 * Manager role → manager-scoped server actions (`requireManager`, scoped by
 * `manager_id`). A module-level constant so its identity never changes and the
 * shared hooks' memoised callbacks stay stable.
 */
export const managerThreadAdapter: ThreadAdapter = {
  loadThread: loadThreadMessagesAction,
  loadOlder: loadOlderMessagesAction,
  // Quoting is a Telegram feature: elsewhere the reply degrades to a plain
  // send (the manager still saw the quote in the optimistic bubble).
  send: (conversationId, body, replyTo, channelType, clientMessageId) =>
    replyTo && channelType === 'telegram'
      ? replyMessageAction(conversationId, replyTo.id, body, clientMessageId)
      : sendMessageAction(conversationId, body, clientMessageId),
  edit: editMessageAction,
  react: reactMessageAction,
  remove: deleteMessageAction,
  forward: forwardMessageAction,
  sendSticker: sendStickerAction,
  sendVoice: sendVoiceAction,
  schedule: sendScheduledMessageAction,
  sendTelegramMedia: (conversationId, file, caption) =>
    sendTelegramMediaAction(conversationId, file, caption),
  uploadRoute: '/api/chat-media/upload',
}
