/**
 * БАРЕЛЬ: admin-accounts разнесён на доменные модули. Существующие импорты
 * `@/app/actions/admin-accounts` продолжают работать без изменений.
 *
 *   admin-accounts-shared.ts       общие типы + validateProxyForType
 *   admin-accounts-telegram.ts     MTProto-логин: телефон/код/2FA/QR
 *   admin-accounts-bots.ts         подключение ботов: MAX + VK Callback API
 *   admin-accounts-maintenance.ts  health-check, смена прокси, удаление
 *
 * НЕ 'use server': server actions реэкспортируются из своих 'use server'
 * модулей, типы — обычные реэкспорты.
 */

export type {
  AdminAccountResult,
  ChannelStatusSnapshot,
} from './admin-accounts-shared'

export {
  adminConnectTelegramAction,
  adminConnectTelegramQrAction,
  adminGetChannelStatusAction,
  adminGetTelegramQrAction,
  adminResendTelegramCodeAction,
  adminRestartTelegramQrAction,
  adminSubmitTelegramCodeAction,
  adminSubmitTelegramPasswordAction,
} from './admin-accounts-telegram'

export {
  adminConnectMaxAction,
  adminConnectVkAction,
} from './admin-accounts-bots'

export {
  adminDeleteChannelAction,
  adminHealthCheckAction,
  adminReassignProxyAction,
  adminSetOutreachAction,
} from './admin-accounts-maintenance'
