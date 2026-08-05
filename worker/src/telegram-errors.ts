/**
 * Telegram error classification, extracted from telegram.ts and re-exported
 * from it for backward compatibility. Normalizes raw GramJS/MTProto errors into
 * short human reasons (incl. the user-facing send-failure reason and coarse
 * error categories). Pure string helpers with no runtime dependencies.
 */

export function errMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { errorMessage?: string; message?: string; seconds?: number }
    if (anyE.errorMessage?.includes('FLOOD_WAIT')) {
      return `FLOOD_WAIT: wait ${anyE.seconds ?? '?'}s before retrying`
    }
    return anyE.errorMessage || anyE.message || String(e)
  }
  return String(e)
}

/**
 * Stable error_reason recorded when a send failed ONLY because the account's
 * session was down at that moment (not a real Telegram rejection). The exact
 * string doubles as the marker the post-reconnect delivery-recovery sweep
 * matches on to know which failed messages are safe to auto-resend.
 */
export const OFFLINE_SEND_REASON =
  'Не доставлено: аккаунт был отключён. Сообщение будет отправлено автоматически после переподключения.'

/**
 * True when a send error means "the session/transport was down", i.e. the
 * message never reached Telegram and re-sending it after reconnect cannot
 * produce a duplicate. Real provider rejections (flood, blocked, privacy…)
 * must NOT match — auto-retrying those would just repeat the same failure.
 */
export function isConnectionSendFailure(e: unknown): boolean {
  const m = errMessage(e).toUpperCase()
  return (
    m.includes('SESSION NOT STARTED') ||
    m.includes('DISCONNECT') || // "Cannot send requests while disconnected"
    m.includes('NOT CONNECTED') ||
    m.includes('CONNECTION CLOSED') ||
    m.includes('TIMEDOUT') ||
    m.includes('TIMEOUT') ||
    m.includes('ECONNRESET') ||
    m.includes('ECONNREFUSED') ||
    m.includes('SOCKET')
  )
}

/**
 * Map a raw Telegram/MTProto send error into a short, human-readable Russian
 * explanation for the panel (stored on messages.error_reason). Kept exhaustive
 * for the send failures a manager actually hits so the inbox "!" marker always
 * says WHY, never just fails silently. Falls back to the raw error text.
 */
export function telegramSendFailureReason(e: unknown): string {
  const raw = errMessage(e)
  const m = raw.toUpperCase()

  // Flood / rate limiting.
  if (m.includes('FLOOD_WAIT')) {
    const secs =
      (e && typeof e === 'object' && typeof (e as { seconds?: number }).seconds === 'number'
        ? (e as { seconds: number }).seconds
        : null) ?? Number(raw.match(/FLOOD_WAIT_(\d+)/)?.[1] ?? 0)
    return secs
      ? `Telegram временно ограничил отправку (флуд-контроль). Подождите ${secs} с и повторите.`
      : 'Telegram временно ограничил отправку (флуд-контроль). Повторите позже.'
  }
  if (m.includes('SLOWMODE_WAIT'))
    return 'В чате включён медленный режим — подождите перед следующим сообщением.'
  if (m.includes('PEER_FLOOD'))
    return 'Аккаунт ограничен Telegram за спам (PEER_FLOOD): отправка новым пользователям временно заблокирована.'

  // Recipient-side restrictions.
  if (m.includes('USER_IS_BLOCKED') || m.includes('YOU_BLOCKED_USER'))
    return 'Пользователь заблокировал этот аккаунт (или вы заблокировали пользователя).'
  if (m.includes('USER_PRIVACY_RESTRICTED') || m.includes('PRIVACY'))
    return 'Настройки приватности пользователя запрещают писать ему первым.'
  if (m.includes('USER_DEACTIVATED') || m.includes('INPUT_USER_DEACTIVATED'))
    return 'Аккаунт пользователя удалён или заблокирован Telegram.'
  if (m.includes('USER_BANNED_IN_CHANNEL'))
    return 'Аккаунт заблокирован в этом канале/чате.'

  // Chat / peer resolution.
  if (m.includes('CHAT_WRITE_FORBIDDEN'))
    return 'Нет прав писать в этот чат.'
  if (m.includes('CHAT_SEND_') && m.includes('FORBIDDEN'))
    return 'Отправка этого типа сообщений запрещена в чате.'
  if (m.includes('PEER_ID_INVALID') || m.includes('PEER_ID_NOT_SUPPORTED'))
    return 'Не удалось определить получателя (peer недоступен).'
  if (m.includes('MSG_ID_INVALID') || m.includes('MESSAGE_ID_INVALID'))
    return 'Сообщение, на которое вы отвечаете, недоступно.'

  // Message content.
  if (m.includes('MESSAGE_TOO_LONG'))
    return 'Сообщение слишком длинное для Telegram.'
  if (m.includes('MESSAGE_EMPTY'))
    return 'Пустое сообщение не может быть отправлено.'

  // Connectivity.
  if (m.includes('TIMEOUT') || m.includes('TIMED OUT'))
    return 'Истекло время ожидания ответа Telegram — проверьте прокси/соединение.'
  if (m.includes('SESSION') && m.includes('NOT STARTED'))
    return 'Сессия Telegram не подключена — переподключите аккаунт.'
  if (m.includes('CONNECT') || m.includes('SOCKET') || m.includes('PROXY'))
    return 'Ошибка соединения с Telegram (прокси недоступен?).'

  return raw ? `Ошибка отправки: ${raw}` : 'Не удалось отправить сообщение.'
}

/** Numeric MTProto error code, if the SDK exposed one (e.g. 420, 400, 406). */
export function extractErrorCode(e: unknown): number | null {
  if (e && typeof e === 'object') {
    const anyE = e as { code?: unknown; errorCode?: unknown }
    const c = anyE.code ?? anyE.errorCode
    return typeof c === 'number' ? c : null
  }
  return null
}

/**
 * Bucket the raw Telegram error into a coarse category so logs make the cause
 * obvious at a glance (diagnostics only — does not change handling).
 */
export function classifyError(msg: string): string {
  const m = msg.toUpperCase()
  if (m.includes('FLOOD_WAIT')) return 'flood_wait'
  if (m.includes('TIMEOUT') || m.includes('TIMED OUT')) return 'timeout'
  if (m.includes('PHONE_NUMBER_INVALID')) return 'phone_invalid'
  if (m.includes('PHONE_NUMBER_BANNED')) return 'phone_banned'
  if (m.includes('PHONE_NUMBER_FLOOD')) return 'phone_number_flood'
  if (m.includes('PHONE_PASSWORD_FLOOD')) return 'password_flood'
  if (m.includes('PHONE_CODE_INVALID')) return 'code_invalid'
  if (m.includes('PHONE_CODE_EXPIRED')) return 'code_expired'
  if (m.includes('PHONE_CODE_EMPTY')) return 'code_empty'
  if (m.includes('SESSION_PASSWORD_NEEDED')) return '2fa_required'
  if (m.includes('PASSWORD_HASH_INVALID')) return 'password_invalid'
  if (m.includes('PHONE_MIGRATE') || m.includes('NETWORK_MIGRATE')) return 'dc_migrate'
  if (m.includes('API_ID') || m.includes('API_HASH')) return 'api_credentials'
  if (m.includes('CONNECT') || m.includes('SOCKET') || m.includes('PROXY')) return 'connection'
  return 'other'
}
