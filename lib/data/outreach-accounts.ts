/**
 * Пул боевых Telegram-аккаунтов исходящего контура (миграция 174).
 *
 * Хранит анти-бан-состояние (прогрев, спам-блок, прокси, api-ключ, счётчики).
 * Секреты (сессия/прокси) наружу не отдаём — только флаги наличия.
 */
import { query } from '../db'
import { encrypt, decrypt } from '../crypto'

export type OutreachAccountStatus =
  | 'new'
  | 'connecting'
  | 'code_pending'
  | 'password_pending'
  | 'online'
  | 'offline'
  | 'error'
  | 'banned'
  | 'quarantined'
  | 'logged_out'

export type SpamblockStatus = 'unknown' | 'clean' | 'limited' | 'blocked'
export type WarmupStage = 'cold' | 'warming' | 'ready'

export interface OutreachAccount {
  id: string
  label: string
  phone: string | null
  apiKeyId: string | null
  apiKeyLabel: string | null
  channelId: string | null
  /** Живой статус сессии связанного канала (источник истины связности). */
  sessionStatus: string | null
  hasSession: boolean
  hasProxy: boolean
  status: OutreachAccountStatus
  spamblockStatus: SpamblockStatus
  spamblockCheckedAt: string | null
  spamblockUntil: string | null
  warmupStage: WarmupStage
  warmupDay: number
  warmupStartedAt: string | null
  dailySent: number
  dailyJoins: number
  hourlySent: number
  assignedManagerId: string | null
  assignedManagerName: string | null
  lastActionAt: string | null
  lastError: string | null
  createdAt: string
  updatedAt: string
}

interface AccountRow {
  id: string
  label: string
  phone: string | null
  api_key_id: string | null
  api_key_label: string | null
  channel_id: string | null
  channel_session_status: string | null
  session_enc: string | null
  proxy_enc: string | null
  status: OutreachAccountStatus
  spamblock_status: SpamblockStatus
  spamblock_checked_at: string | null
  spamblock_until: string | null
  warmup_stage: WarmupStage
  warmup_day: number
  warmup_started_at: string | null
  daily_sent: number
  daily_joins: number
  hourly_sent: number
  assigned_manager_id: string | null
  assigned_manager_name: string | null
  last_action_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

function mapAccount(r: AccountRow): OutreachAccount {
  return {
    id: r.id,
    label: r.label,
    phone: r.phone,
    apiKeyId: r.api_key_id,
    apiKeyLabel: r.api_key_label,
    channelId: r.channel_id,
    sessionStatus: r.channel_session_status,
    hasSession: Boolean(r.session_enc),
    hasProxy: Boolean(r.proxy_enc),
    status: r.status,
    spamblockStatus: r.spamblock_status,
    spamblockCheckedAt: r.spamblock_checked_at,
    spamblockUntil: r.spamblock_until,
    warmupStage: r.warmup_stage,
    warmupDay: r.warmup_day,
    warmupStartedAt: r.warmup_started_at,
    dailySent: r.daily_sent,
    dailyJoins: r.daily_joins,
    hourlySent: r.hourly_sent,
    assignedManagerId: r.assigned_manager_id,
    assignedManagerName: r.assigned_manager_name,
    lastActionAt: r.last_action_at,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

const SELECT = `
  SELECT a.*,
         k.label AS api_key_label,
         m.name AS assigned_manager_name,
         c.session_status AS channel_session_status
    FROM outreach_accounts a
    LEFT JOIN outreach_api_keys k ON k.id = a.api_key_id
    LEFT JOIN managers m ON m.id = a.assigned_manager_id
    LEFT JOIN channels c ON c.id = a.channel_id
`

export async function listAccounts(): Promise<OutreachAccount[]> {
  const rows = await query<AccountRow>(`${SELECT} ORDER BY a.created_at`)
  return rows.map(mapAccount)
}

export async function getAccount(id: string): Promise<OutreachAccount | null> {
  const rows = await query<AccountRow>(`${SELECT} WHERE a.id = $1`, [id])
  return rows[0] ? mapAccount(rows[0]) : null
}

export async function createAccount(input: {
  label: string
  phone?: string
  apiKeyId: string
  proxy?: string
  deviceModel?: string
  systemVersion?: string
  appVersion?: string
}): Promise<string> {
  const rows = await query<{ id: string }>(
    `INSERT INTO outreach_accounts
       (label, phone, api_key_id, proxy_enc,
        device_model, system_version, app_version, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'new')
     RETURNING id`,
    [
      input.label.trim(),
      input.phone?.trim() || null,
      input.apiKeyId,
      input.proxy?.trim() ? encrypt(input.proxy.trim()) : null,
      input.deviceModel?.trim() || null,
      input.systemVersion?.trim() || null,
      input.appVersion?.trim() || null,
    ],
  )
  return rows[0].id
}

/** Привязать аккаунт к каналу (после успешного подключения сессии). */
export async function linkAccountChannel(
  id: string,
  channelId: string,
): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET channel_id = $2, status = 'online', updated_at = now()
      WHERE id = $1`,
    [id, channelId],
  )
}

/** Аккаунт по связанному каналу (для ингеста ответов/статусов из воркера). */
export async function getAccountByChannelId(
  channelId: string,
): Promise<OutreachAccount | null> {
  const rows = await query<AccountRow>(`${SELECT} WHERE a.channel_id = $1`, [
    channelId,
  ])
  return rows[0] ? mapAccount(rows[0]) : null
}

export async function setAccountProxy(
  id: string,
  proxy: string | null,
): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET proxy_enc = $2, updated_at = now()
      WHERE id = $1`,
    [id, proxy && proxy.trim() ? encrypt(proxy.trim()) : null],
  )
}

export async function setAccountStatus(
  id: string,
  status: OutreachAccountStatus,
  lastError?: string | null,
): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET status = $2, last_error = $3, updated_at = now()
      WHERE id = $1`,
    [id, status, lastError ?? null],
  )
}

export async function reassignAccount(
  id: string,
  managerId: string | null,
): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET assigned_manager_id = $2, updated_at = now()
      WHERE id = $1`,
    [id, managerId],
  )
}

export async function deleteAccount(id: string): Promise<void> {
  await query(`DELETE FROM outreach_accounts WHERE id = $1`, [id])
}

/** Расшифрованный прокси (для воркера). */
export async function getAccountProxy(id: string): Promise<string | null> {
  const rows = await query<{ proxy_enc: string | null }>(
    `SELECT proxy_enc FROM outreach_accounts WHERE id = $1`,
    [id],
  )
  const enc = rows[0]?.proxy_enc
  if (!enc) return null
  try {
    return decrypt(enc)
  } catch {
    return null
  }
}

/**
 * Аккаунты, пригодные для боевой отправки прямо сейчас: онлайн, прогреты,
 * без спам-блока, в пределах дневного/часового капа. Опционально скоуп по
 * менеджеру (закреплённые за ним + общий пул без закрепления).
 */
export async function listSendableAccounts(opts: {
  managerId?: string
  dailyCap: number
  hourlyCap: number
}): Promise<OutreachAccount[]> {
  const rows = await query<AccountRow>(
    `${SELECT}
      WHERE a.status = 'online'
        AND a.warmup_stage = 'ready'
        AND a.spamblock_status = 'clean'
        AND (a.spamblock_until IS NULL OR a.spamblock_until < now())
        AND a.daily_sent < $2
        AND a.hourly_sent < $3
        AND (
          $1::uuid IS NULL
          OR a.assigned_manager_id = $1::uuid
          OR a.assigned_manager_id IS NULL
        )
      ORDER BY a.daily_sent ASC, a.last_action_at ASC NULLS FIRST`,
    [opts.managerId ?? null, opts.dailyCap, opts.hourlyCap],
  )
  return rows.map(mapAccount)
}

/** Инкремент счётчиков после успешной отправки. */
export async function markAccountSent(id: string): Promise<void> {
  await query(
    `UPDATE outreach_accounts
        SET daily_sent = daily_sent + 1,
            hourly_sent = hourly_sent + 1,
            last_action_at = now(),
            updated_at = now()
      WHERE id = $1`,
    [id],
  )
}
