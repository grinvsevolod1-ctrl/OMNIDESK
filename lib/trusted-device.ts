import 'server-only'
import { createHash, randomBytes } from 'node:crypto'
import { SignJWT } from 'jose'
import { cookies } from 'next/headers'
import { query } from './db'
import { sendPushToManager } from './push'
import { getAuthSecret } from './session'

/**
 * Доверенные устройства для 2FA («запомнить на 30 дней») + детект входа с
 * нового устройства.
 *
 * Модель доверия: в браузере живёт cookie со случайным 256-битным токеном,
 * в БД — только его SHA-256. Пропуск действителен, пока (а) не истёк срок,
 * (б) session_version на момент выдачи совпадает с текущим. Любая смена
 * пароля или «разлогинить все устройства» продвигает session_version и
 * мгновенно обесценивает ВСЕ выданные пропуски — отдельной чистки не нужно.
 *
 * Детект нового устройства: пары (браузер+ОС, IP) копятся в login_devices;
 * первый вход с новой пары -> push всем устройствам сотрудника с кнопками
 * «Да, это я» / «Разлогинить все». Кнопка кика несёт короткоживущий
 * подписанный токен — работает даже с устройства с протухшей сессией.
 */

const TRUSTED_COOKIE = 'omnidesk_trusted_device'
const TRUSTED_TTL_S = 30 * 24 * 3600 // 30 дней

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/**
 * Нормализованный отпечаток устройства: семейство браузера + ОС. Сырой UA
 * не годится как ключ — он меняется при каждом минорном обновлении браузера,
 * и каждый апдейт Chrome выглядел бы как «новое устройство».
 */
export function deviceKeyFromUa(ua: string | null): string {
  const s = (ua ?? '').toLowerCase()
  let browser = 'other'
  if (s.includes('firefox/')) browser = 'firefox'
  else if (s.includes('edg/')) browser = 'edge'
  else if (s.includes('opr/') || s.includes('opera')) browser = 'opera'
  else if (s.includes('yabrowser/')) browser = 'yandex'
  else if (s.includes('chrome/')) browser = 'chrome'
  else if (s.includes('safari/')) browser = 'safari'
  let os = 'other'
  if (s.includes('windows')) os = 'windows'
  else if (s.includes('android')) os = 'android'
  else if (s.includes('iphone') || s.includes('ipad')) os = 'ios'
  else if (s.includes('mac os')) os = 'macos'
  else if (s.includes('linux')) os = 'linux'
  return `${browser}-${os}`
}

/** Выдать пропуск текущему браузеру и записать hash в БД. */
export async function grantTrustedDevice(
  managerId: string,
  sessionVersion: number,
  ua: string | null,
  ip: string | null,
): Promise<void> {
  const token = randomBytes(32).toString('base64url')
  await query(
    `INSERT INTO trusted_devices
       (manager_id, token_hash, session_version, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + interval '30 days')`,
    [managerId, hashToken(token), sessionVersion, ua, ip],
  )
  const store = await cookies()
  store.set(TRUSTED_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: TRUSTED_TTL_S,
  })
}

/**
 * Пропускает ли текущий браузер шаг 2FA для этого сотрудника. Сверяет hash
 * токена, срок и session_version; на успехе освежает last_used_at.
 * Fail-closed: любая ошибка (нет таблицы до миграции, сбой БД) = «не доверен».
 */
export async function isTrustedDevice(
  managerId: string,
  currentSessionVersion: number,
): Promise<boolean> {
  try {
    const store = await cookies()
    const token = store.get(TRUSTED_COOKIE)?.value
    if (!token) return false
    const rows = await query<{ id: string }>(
      `UPDATE trusted_devices
          SET last_used_at = now()
        WHERE token_hash = $1
          AND manager_id = $2
          AND session_version = $3
          AND expires_at > now()
        RETURNING id`,
      [hashToken(token), managerId, currentSessionVersion],
    )
    return rows.length > 0
  } catch {
    return false
  }
}

export interface TrustedDeviceInfo {
  id: string
  userAgent: string | null
  ip: string | null
  createdAt: string
  lastUsedAt: string | null
  expiresAt: string
  /** Пропуск выдан под текущий session_version (иначе он уже мёртв). */
  active: boolean
}

/** Список пропусков сотрудника для вкладки «Сессии». */
export async function listTrustedDevices(
  managerId: string,
  currentSessionVersion: number,
): Promise<TrustedDeviceInfo[]> {
  try {
    const rows = await query<{
      id: string
      user_agent: string | null
      ip: string | null
      created_at: string
      last_used_at: string | null
      expires_at: string
      session_version: number
    }>(
      `SELECT id, user_agent, ip, created_at, last_used_at, expires_at, session_version
         FROM trusted_devices
        WHERE manager_id = $1 AND expires_at > now()
        ORDER BY COALESCE(last_used_at, created_at) DESC
        LIMIT 20`,
      [managerId],
    )
    return rows.map((r) => ({
      id: r.id,
      userAgent: r.user_agent,
      ip: r.ip,
      createdAt: String(r.created_at),
      lastUsedAt: r.last_used_at ? String(r.last_used_at) : null,
      expiresAt: String(r.expires_at),
      active: r.session_version === currentSessionVersion,
    }))
  } catch {
    return []
  }
}

/** Отозвать один пропуск (свой — скоуп по manager_id). */
export async function revokeTrustedDevice(
  managerId: string,
  deviceId: string,
): Promise<void> {
  await query(
    'DELETE FROM trusted_devices WHERE manager_id = $1 AND id = $2',
    [managerId, deviceId],
  )
}

/**
 * Зафиксировать вход с устройства и сообщить, новое ли оно. Fail-open в
 * сторону «не новое»: сбой учёта не должен ни ломать вход, ни спамить
 * ложными тревогами (до наката миграции 134 таблицы нет).
 */
export async function recordLoginDevice(
  managerId: string,
  ua: string | null,
  ip: string,
): Promise<{ isNew: boolean }> {
  try {
    const rows = await query<{ inserted: boolean }>(
      `INSERT INTO login_devices (manager_id, device_key, ip, user_agent)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (manager_id, device_key, ip)
         DO UPDATE SET last_seen_at = now(), user_agent = $4
       RETURNING (xmax = 0) AS inserted`,
      [managerId, deviceKeyFromUa(ua), ip, ua],
    )
    const firstEver = await query<{ n: string }>(
      `SELECT count(*)::text AS n FROM login_devices WHERE manager_id = $1`,
      [managerId],
    )
    // Самый первый вход сотрудника вообще — не тревога: у него ещё нет
    // «известных» устройств, уведомлять не о чем (и push ещё не подключён).
    if (Number(firstEver[0]?.n ?? 0) <= 1) return { isNew: false }
    return { isNew: Boolean(rows[0]?.inserted) }
  } catch {
    return { isNew: false }
  }
}

/** Человекочитаемое имя устройства из ключа вида "chrome-windows". */
function humanDevice(ua: string | null): string {
  const key = deviceKeyFromUa(ua)
  const [browser, os] = key.split('-')
  const b: Record<string, string> = {
    chrome: 'Chrome',
    firefox: 'Firefox',
    safari: 'Safari',
    edge: 'Edge',
    opera: 'Opera',
    yandex: 'Яндекс Браузер',
    other: 'Браузер',
  }
  const o: Record<string, string> = {
    windows: 'Windows',
    macos: 'macOS',
    linux: 'Linux',
    android: 'Android',
    ios: 'iPhone/iPad',
    other: '',
  }
  return [b[browser] ?? 'Браузер', o[os] ?? ''].filter(Boolean).join(' на ')
}

/**
 * Push «Вход с нового устройства» на ВСЕ устройства сотрудника с кнопками
 * «Да, это я» / «Разлогинить все». Кнопка кика несёт подписанный одноразовый
 * по смыслу токен (24 ч): эндпоинт /api/security/kick продвигает
 * session_version, что разом убивает все сессии И все trusted-пропуски.
 * Fire-and-forget: никогда не бросает и не задерживает вход.
 */
export async function notifyNewDeviceLogin(
  managerId: string,
  managerName: string,
  ua: string | null,
  ip: string,
): Promise<void> {
  try {
    const kickToken = await new SignJWT({ purpose: 'kick' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(managerId)
      .setIssuedAt()
      .setExpirationTime('24h')
      .sign(getAuthSecret())
    await sendPushToManager(managerId, {
      title: 'Вход с нового устройства',
      body: `${humanDevice(ua)}, IP ${ip}. Это вы?`,
      tag: `security-login-${managerId}`,
      kind: 'security',
      kickToken,
      url: '/login',
    })
  } catch {
    /* уведомление не должно ломать вход */
  }
}
