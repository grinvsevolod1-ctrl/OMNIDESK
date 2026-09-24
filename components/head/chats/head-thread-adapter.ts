import {
  loadHeadThreadMessagesAction,
  loadOlderHeadMessagesAction,
} from '@/app/actions/head-chats'
import type {
  ActionResult,
  ThreadAdapter,
} from '@/components/shared/inbox/thread-adapter'

/**
 * Руководитель → ТОЛЬКО ЧТЕНИЕ. Живые здесь лишь лоадеры истории (общее ядро
 * `useThreadHistory` + realtime-догрузка открытого треда); все мутации
 * намеренно закорочены на отказ, а UI их и не показывает (`viewOnly` лента,
 * композер заменён плашкой). Серверных экшенов на запись у роли head для
 * переписки нет — даже подмена адаптера в DevTools упрётся в отсутствие
 * маршрута.
 */
const READ_ONLY: ActionResult = {
  ok: false,
  message: 'Режим просмотра: действия с перепиской недоступны руководителю.',
}
const readOnly = async (): Promise<ActionResult> => READ_ONLY

export const headThreadAdapter: ThreadAdapter = {
  loadThread: loadHeadThreadMessagesAction,
  loadOlder: loadOlderHeadMessagesAction,
  send: readOnly,
  edit: readOnly,
  react: readOnly,
  remove: readOnly,
  forward: readOnly,
  sendSticker: readOnly,
  sendVoice: readOnly,
  schedule: readOnly,
  sendTelegramMedia: readOnly,
  uploadRoute: '',
}
