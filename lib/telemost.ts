import 'server-only'

/**
 * Yandex Telemost integration.
 *
 * Telemost is a video-meeting service (Yandex 360 for Business), NOT a
 * messenger — it has no inbound message stream. The product flow here is:
 * a manager creates a meeting from inside any conversation, and OMNIDESK sends
 * the join link to the client through that conversation's own channel.
 *
 * API: POST https://cloud-api.yandex.net/v1/telemost-api/conferences
 *   Authorization: OAuth <token>   (token needs telemost-api:conferences.create)
 *   -> 201 { id, join_url, ... }
 *
 * Requires YANDEX_TELEMOST_OAUTH_TOKEN. If it's absent the feature degrades
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

/** True when a Telemost token is configured, so UI can hide/disable the button. */
export function isTelemostConfigured(): boolean {
  return Boolean(process.env.YANDEX_TELEMOST_OAUTH_TOKEN)
}

/**
 * Create a Telemost conference and return its join URL. Never throws — network
 * and API errors are normalised into a { ok: false } result with a
 * human-readable Russian message for the operator.
 */
export async function createTelemostMeeting(opts?: {
  waitingRoomLevel?: WaitingRoomLevel
}): Promise<TelemostResult> {
  const token = process.env.YANDEX_TELEMOST_OAUTH_TOKEN
  if (!token) {
    return {
      ok: false,
      message:
        'Яндекс Телемост не настроен: добавьте YANDEX_TELEMOST_OAUTH_TOKEN в настройках.',
    }
  }

  try {
    const res = await fetch(TELEMOST_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        waiting_room_level: opts?.waitingRoomLevel ?? 'PUBLIC',
      }),
      // Meetings are always fresh; never cache.
      cache: 'no-store',
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      console.error('[v0] telemost create failed:', res.status, detail)
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
    console.error('[v0] telemost request error:', err)
    return {
      ok: false,
      message: 'Ошибка соединения с Яндекс Телемост. Попробуйте ещё раз.',
    }
  }
}
