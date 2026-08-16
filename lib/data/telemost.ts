/**
 * Yandex Telemost integration: config vault + meeting records.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { query } from '../db'
import { decrypt, encrypt, maskSecret } from '../crypto'

/* =========================== Yandex Telemost ============================ */

/**
 * App-level Telemost config, stored under app_settings key `telemost` and
 * managed by the admin (not via env vars). The OAuth token is encrypted at rest;
 * everything else is non-secret. `enabled` lets the admin turn the feature off
 * without deleting the token.
 */
export interface TelemostConfig {
  /** Decrypted OAuth token for cloud-api.yandex.net (telemost-api scope). */
  token: string
  /** Default waiting-room level applied to new meetings. */
  waitingRoomLevel: 'PUBLIC' | 'ORGANIZATION' | 'ADMINISTRATOR'
  /** When false, the feature is hidden even if a token exists. */
  enabled: boolean
}

const TELEMOST_KEY = 'telemost'

interface TelemostConfigRow {
  token?: string
  waitingRoomLevel?: TelemostConfig['waitingRoomLevel']
  enabled?: boolean
}

async function readTelemostRow(): Promise<TelemostConfigRow | null> {
  const rows = await query<{ value: TelemostConfigRow }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [TELEMOST_KEY],
  )
  return rows[0]?.value ?? null
}

/** Read + decrypt the full Telemost config. Null when no token is saved. */
export async function getTelemostConfig(): Promise<TelemostConfig | null> {
  const v = await readTelemostRow()
  if (!v?.token) return null
  try {
    return {
      token: decrypt(v.token),
      waitingRoomLevel: v.waitingRoomLevel ?? 'PUBLIC',
      enabled: v.enabled ?? true,
    }
  } catch (err) {
    console.error('getTelemostConfig: decrypt failed:', err)
    return null
  }
}

/** Non-secret view of the config for admin display. */
export interface TelemostStatus {
  /** A token is saved. */
  configured: boolean
  /** Token saved AND the feature is enabled — the button appears for managers. */
  enabled: boolean
  waitingRoomLevel: TelemostConfig['waitingRoomLevel']
  tokenMask: string | null
}

export async function getTelemostStatus(): Promise<TelemostStatus> {
  const v = await readTelemostRow()
  let tokenMask: string | null = null
  if (v?.token) {
    try {
      tokenMask = maskSecret(decrypt(v.token))
    } catch {
      tokenMask = null
    }
  }
  return {
    configured: Boolean(v?.token),
    enabled: Boolean(v?.token) && (v?.enabled ?? true),
    waitingRoomLevel: v?.waitingRoomLevel ?? 'PUBLIC',
    tokenMask,
  }
}

/**
 * Admin: save Telemost settings. A blank token keeps the existing one (so the
 * admin can toggle enabled / change the waiting-room level without re-entering
 * the secret). Passing `clearToken` removes it entirely.
 */
export async function saveTelemostConfig(input: {
  token?: string
  waitingRoomLevel: TelemostConfig['waitingRoomLevel']
  enabled: boolean
  clearToken?: boolean
}): Promise<void> {
  const existing = await readTelemostRow()
  let token = existing?.token
  if (input.clearToken) {
    token = undefined
  } else if (input.token && input.token.trim()) {
    token = encrypt(input.token.trim())
  }
  const value: TelemostConfigRow = {
    token,
    waitingRoomLevel: input.waitingRoomLevel,
    enabled: input.enabled,
  }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [TELEMOST_KEY, JSON.stringify(value)],
  )
}

/** A meeting row for the manager's Видеовстречи tab. */
export interface TelemostMeetingRecord {
  id: string
  conversationId: string | null
  contactName: string | null
  joinUrl: string
  delivered: boolean
  createdAt: string
}

/** Record a created meeting (best-effort history). */
export async function recordTelemostMeeting(input: {
  managerId: string
  conversationId?: string | null
  conferenceId?: string
  joinUrl: string
  delivered: boolean
}): Promise<void> {
  try {
    await query(
      `INSERT INTO telemost_meetings
         (manager_id, conversation_id, conference_id, join_url, delivered)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        input.managerId,
        input.conversationId ?? null,
        input.conferenceId ?? '',
        input.joinUrl,
        input.delivered,
      ],
    )
  } catch (err) {
    // History table missing (pre-042) — never fail the actual meeting creation.
    console.error('recordTelemostMeeting skipped:', err)
  }
}

/** Recent meetings created by a manager (most recent first). */
export async function listTelemostMeetings(
  managerId: string,
  limit = 30,
): Promise<TelemostMeetingRecord[]> {
  try {
    const rows = await query<{
      id: string
      conversation_id: string | null
      contact_name: string | null
      join_url: string
      delivered: boolean
      created_at: string
    }>(
      `SELECT m.id, m.conversation_id, c.contact_name, m.join_url,
              m.delivered, m.created_at
         FROM telemost_meetings m
         LEFT JOIN conversations c ON c.id = m.conversation_id
        WHERE m.manager_id = $1
        ORDER BY m.created_at DESC
        LIMIT $2`,
      [managerId, limit],
    )
    return rows.map((r) => ({
      id: r.id,
      conversationId: r.conversation_id,
      contactName: r.contact_name,
      joinUrl: r.join_url,
      delivered: r.delivered,
      createdAt: r.created_at,
    }))
  } catch (err) {
    console.error('listTelemostMeetings failed:', err)
    return []
  }
}
