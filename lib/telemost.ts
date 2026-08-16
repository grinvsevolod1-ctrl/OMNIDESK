import 'server-only'
import { getTelemostConfig, type TelemostConfig } from '@/lib/data'

/**
 * Yandex Telemost integration.
 *
 * Telemost is a video-meeting service (Yandex 360 for Business), NOT a
 * messenger — it has no inbound message stream. The product flow here is:
 * a manager creates a meeting (from a conversation or from the Видеовстречи
 * tab), and OMNIDESK can send the join link to a client through a channel.
 *
 * API: POST https://cloud-api.yandex.net/v1/telemost-api/conferences
 *   Authorization: OAuth <token>   (token needs telemost-api:conferences.create)
 *   -> 201 { id, join_url, ... }
 *
 * Configuration lives in the DB (app_settings key `telemost`), managed by the
 * admin. For backwards compatibility a YANDEX_TELEMOST_OAUTH_TOKEN env var is
 * still honoured as a fallback. When nothing is configured the feature degrades
 * gracefully: callers get { ok: false } with a clear message instead of a crash.
 */

const TELEMOST_ENDPOINT =
  'https://cloud-api.yandex.net/v1/telemost-api/conferences'

export type WaitingRoomLevel = 'PUBLIC' | 'ORGANIZATION' | 'ADMINISTRATOR'

export interface TelemostMeeting {
  id: string
  joinUrl: string
}

export type TelemostResult =
  | { ok: true; meeting: TelemostMeeting }
  | { ok: false; message: string }

/**
 * Resolve the effective config: DB config first (admin-managed), then the env
 * var fallback. Returns null when neither is available. Also respects the
 * admin's `enabled` toggle for the DB config.
 */
async function resolveTelemost(): Promise<{
  token: string
  waitingRoomLevel: WaitingRoomLevel
} | null> {
  let cfg: TelemostConfig | null = null
  try {
    cfg = await getTelemostConfig()
  } catch (err) {
    console.error('resolveTelemost: config read failed:', err)
  }
  if (cfg?.token && cfg.enabled) {
    return { token: cfg.token, waitingRoomLevel: cfg.waitingRoomLevel }
  }
  const envToken = process.env.YANDEX_TELEMOST_OAUTH_TOKEN
  if (envToken) {
    return { token: envToken, waitingRoomLevel: 'PUBLIC' }
  }
  return null
}

/**
 * True when Telemost is configured AND enabled, so UI can show/hide the button.
 * Async because the config lives in the database.
 */
export async function isTelemostConfigured(): Promise<boolean> {
  return (await resolveTelemost()) !== null
}

/**
 * Create a Telemost conference and return its join URL. Never throws — network
 * and API errors are normalised into a { ok: false } result with a
 * human-readable Russian message for the operator.
 */
export async function createTelemostMeeting(opts?: {
  waitingRoomLevel?: WaitingRoomLevel
}): Promise<TelemostResult> {
  const resolved = await resolveTelemost()
  if (!resolved) {
    return {
      ok: false,
      message:
        'Яндекс Телемост не настроен. Обратитесь к администратору для подключения.',
    }
  }
  const { token } = resolved

  try {
    const res = await fetch(TELEMOST_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        waiting_room_level:
          opts?.waitingRoomLevel ?? resolved.waitingRoomLevel,
      }),
      // Meetings are always fresh; never cache.
      cache: 'no-store',
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('telemost create failed:', res.status, detail)
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          message:
            'Токен Телемост недействителен или без прав на создание встреч.',
        }
      }
      return {
        ok: false,
        message: `Не удалось создать встречу (код ${res.status}).`,
      }
    }

    const data = (await res.json()) as {
      id?: string
      join_url?: string
    }
    if (!data.join_url) {
      return { ok: false, message: 'Телемост не вернул ссылку на встречу.' }
    }
    return {
      ok: true,
      meeting: { id: data.id ?? '', joinUrl: data.join_url },
    }
  } catch (err) {
    console.error('telemost request error:', err)
    return {
      ok: false,
      message: 'Ошибка соединения с Яндекс Телемост. Попробуйте ещё раз.',
    }
  }
}
