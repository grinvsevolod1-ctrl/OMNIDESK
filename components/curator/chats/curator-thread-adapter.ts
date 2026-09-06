import {
  deleteCuratorMessageAction,
  editCuratorMessageAction,
  forwardCuratorMessageAction,
  loadCuratorThreadMessagesAction,
  loadOlderCuratorMessagesAction,
  reactCuratorMessageAction,
  sendCuratorMessageAction,
  sendCuratorScheduledMessageAction,
  sendCuratorStickerAction,
  sendCuratorTelegramMediaAction,
  sendCuratorVoiceAction,
} from '@/app/actions/curator-messages'
import type { ThreadAdapter } from '@/components/shared/inbox/thread-adapter'

/**
 * Curator role → curator-scoped server actions (`requireCurator`, scoped by
 * `conversations.curator_id`; delivery still goes through the worker under
 * the channel's owner manager). Module-level constant — stable identity for
 * the shared hooks' memoised callbacks.
 */
export const curatorThreadAdapter: ThreadAdapter = {
  loadThread: loadCuratorThreadMessagesAction,
  loadOlder: loadOlderCuratorMessagesAction,
  send: (conversationId, body, replyTo, _channelType, clientMessageId) =>
    sendCuratorMessageAction(conversationId, body, replyTo?.id, clientMessageId),
  edit: editCuratorMessageAction,
  react: reactCuratorMessageAction,
  remove: deleteCuratorMessageAction,
  forward: forwardCuratorMessageAction,
  sendSticker: sendCuratorStickerAction,
  sendVoice: sendCuratorVoiceAction,
  schedule: sendCuratorScheduledMessageAction,
  sendTelegramMedia: sendCuratorTelegramMediaAction,
  uploadRoute: '/api/curator-media/upload',
}
