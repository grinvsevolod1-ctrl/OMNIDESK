/**
 * Пул Telegram API-ключей исходящего контура (миграция 173).
 *
 * Анти-бан: боевые аккаунты распределяются по нескольким парам api_id/api_hash,
 * чтобы один app_id не светился на десятках аккаунтов. api_hash хранится
 * зашифрованным; наружу (в UI) отдаём только маску.
 */
import { query } from '../db'
import { encrypt, decrypt, maskSecret } from '../crypto'

export type OutreachApiKeyStatus = 'active' | 'disabled'

export interface OutreachApiKey {
  id: string
  label: string
  apiId: number
  /** Маскированный hash для UI — реальный hash наружу не отдаём. */
  apiHashMasked: string
  maxAccounts: number
  status: OutreachApiKeyStatus
  /** Сколько аккаунтов сейчас висит на ключе (для «загрузки» ключа). */
  accountsCount: number
  createdAt: string
  updatedAt: string
}

interface KeyRow {
  id: string
  label: string
  api_id: number
  api_hash_enc: string
  max_accounts: number
  status: OutreachApiKeyStatus
  accounts_count: string | number
  created_at: string
  updated_at: string
}

function mapKey(r: KeyRow): OutreachApiKey {
  let masked = '••••'
  try {
    masked = maskSecret(decrypt(r.api_hash_enc))
  } catch {
    /* повреждённый шифртекст — показываем заглушку, не роняем список */
  }
  return {
    id: r.id,
    label: r.label,
    apiId: r.api_id,
    apiHashMasked: masked,
    maxAccounts: r.max_accounts,
    status: r.status,
    accountsCount: Number(r.accounts_count) || 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** Список ключей с текущей загрузкой (число привязанных аккаунтов). */
export async function listApiKeys(): Promise<OutreachApiKey[]> {
  const rows = await query<KeyRow>(
    `SELECT k.*,
            (SELECT count(*) FROM outreach_accounts a WHERE a.api_key_id = k.id)
              AS accounts_count
       FROM outreach_api_keys k
      ORDER BY k.created_at`,
  )
  return rows.map(mapKey)
}

/** Создать ключ. api_hash шифруется на входе. */
export async function createApiKey(input: {
  label: string
  apiId: number
  apiHash: string
  maxAccounts?: number
}): Promise<string> {
  const hash = input.apiHash.trim()
  if (!input.apiId || !hash) {
    throw new Error('Нужны api_id и api_hash')
  }
  const rows = await query<{ id: string }>(
    `INSERT INTO outreach_api_keys (label, api_id, api_hash_enc, max_accounts)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [
      input.label.trim(),
      input.apiId,
      encrypt(hash),
      Math.max(1, Math.round(input.maxAccounts ?? 20)),
    ],
  )
  return rows[0].id
}

export async function setApiKeyStatus(
  id: string,
  status: OutreachApiKeyStatus,
): Promise<void> {
  await query(
    `UPDATE outreach_api_keys SET status = $2, updated_at = now() WHERE id = $1`,
    [id, status],
  )
}

export async function setApiKeyMaxAccounts(
  id: string,
  maxAccounts: number,
): Promise<void> {
  await query(
    `UPDATE outreach_api_keys
        SET max_accounts = $2, updated_at = now()
      WHERE id = $1`,
    [id, Math.max(1, Math.round(maxAccounts))],
  )
}

export async function deleteApiKey(id: string): Promise<void> {
  await query(`DELETE FROM outreach_api_keys WHERE id = $1`, [id])
}

/**
 * Выбрать наименее загруженный активный ключ для нового аккаунта: активный,
 * с accounts_count < max_accounts, с наименьшей загрузкой. Возвращает null,
 * если свободных ключей нет.
 */
export async function pickApiKeyForNewAccount(): Promise<string | null> {
  const rows = await query<{ id: string }>(
    `SELECT k.id
       FROM outreach_api_keys k
       LEFT JOIN (
         SELECT api_key_id, count(*) AS cnt
           FROM outreach_accounts
          GROUP BY api_key_id
       ) a ON a.api_key_id = k.id
      WHERE k.status = 'active'
        AND COALESCE(a.cnt, 0) < k.max_accounts
      ORDER BY COALESCE(a.cnt, 0) ASC, k.created_at ASC
      LIMIT 1`,
  )
  return rows[0]?.id ?? null
}

/** Расшифрованные креды ключа (для воркера/подключения). Никогда не в UI. */
export async function getApiCreds(
  apiKeyId: string,
): Promise<{ apiId: number; apiHash: string } | null> {
  const rows = await query<{ api_id: number; api_hash_enc: string }>(
    `SELECT api_id, api_hash_enc FROM outreach_api_keys WHERE id = $1`,
    [apiKeyId],
  )
  if (!rows[0]) return null
  try {
    return { apiId: rows[0].api_id, apiHash: decrypt(rows[0].api_hash_enc) }
  } catch {
    return null
  }
}
