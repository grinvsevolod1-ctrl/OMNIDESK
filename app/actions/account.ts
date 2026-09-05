/**
 * Барель server actions личного кабинета менеджера. Реализация разнесена по
 * доменам; существующие импорты `@/app/actions/account` продолжают работать.
 *
 *   account-profile.ts    обед (доступность) и смена собственного пароля
 *   account-messaging.ts  отправка текста, прочитано, отложенные, голосовые, стикеры
 *   account-media.ts      вложения WhatsApp Cloud и VK (upload + send)
 *   account-shared.ts     общие типы (НЕ 'use server')
 */

export {
  changeOwnPasswordAction,
  getAdminAvatarAction,
  getLunchStateAction,
  setLunchAction,
  updateAdminAvatarAction,
  updateMyAvatarAction,
  updateMyProfileAction,
} from './account-profile'
export {
  markConversationReadAction,
  sendMessageAction,
  sendScheduledMessageAction,
  sendStickerAction,
  sendVoiceAction,
  trashReworkLeadAction,
} from './account-messaging'
export {
  sendVkMediaAction,
  sendWhatsappMediaAction,
} from './account-media'
export type { SimpleResult } from './account-shared'
