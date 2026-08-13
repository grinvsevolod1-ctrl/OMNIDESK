import bcrypt from 'bcryptjs'
import { randomInt } from 'crypto'
import { generate, generateSecret, generateURI, verify } from 'otplib'
import { decrypt, encrypt } from './crypto'
import { query } from './db'

/**
 * Two-factor authentication core for managers/curators.
 *
 * Methods:
 *  - 'totp'     — authenticator app; secret stored AES-256-GCM encrypted.
 *  - 'telegram' — the employee's OWN Telegram bot (BotFather). We deliver a
 *                 6-digit code via the free Bot API to one or more chat IDs.
 *
 * Login flow integration (app/actions/auth.ts):
 *  password ok + 2FA on → create a challenge, set a short signed cookie,
 *  show the code step; verify2faAction validates and starts the session.
 *
 * Admin override paths intentionally BYPASS 2FA (product requirement):
 *  - god-panel temporary password (tempOk in loginAction);
 *  - hidden admin master-login (admin password against an employee login).
 * This module contains NO god-panel imports (see lib/ai/isolation.test.ts).
 */

/* ------------------------------ Types ------------------------------- */

export type TwofaMethod = 'off' | 'totp' | 'telegram'

export interface TwofaConfig {
  method: TwofaMethod
  /** Decrypted TOTP secret (base32) when method='totp'. */
  totpSecret: string | null
  /** Decrypted bot token when method='telegram'. */
  telegramToken: string | null
  /** Telegram chat IDs receiving login codes. */
  telegramChatIds: string[]
  /** Bcrypt hashes of unused one-time backup codes. */
  backupCodes: string[]
  enabledAt: string | Date | null
}

interface TwofaRow {
  twofa_method: string
  twofa_totp_secret_enc: string | null
  twofa_telegram_token_enc: string | null
  twofa_telegram_chat_ids: unknown
  twofa_backup_codes: unknown
  twofa_enabled_at: string | Date | null
}

function parseStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string') {
    try {
      const arr = JSON.parse(value)
      return Array.isArray(arr) ? arr.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

function safeDecrypt(envelope: string | null): string | null {
  if (!envelope) return null
  try {
    return decrypt(envelope)
  } catch {
    return null
  }
}

/* --------------------------- Config CRUD ----------------------------- */

/** Read the 2FA configuration for an account. Fail-closed to 'off'. */
export async function getTwofaConfig(managerId: string): Promise<TwofaConfig> {
  const rows = await query<TwofaRow>(
    `SELECT twofa_method, twofa_totp_secret_enc, twofa_telegram_token_enc,
            twofa_telegram_chat_ids, twofa_backup_codes, twofa_enabled_at
       FROM managers WHERE id = $1 LIMIT 1`,
    [managerId],
  )
  const row = rows[0]
  if (!row) {
    return {
      method: 'off',
      totpSecret: null,
      telegramToken: null,
      telegramChatIds: [],
      backupCodes: [],
      enabledAt: null,
    }
  }
  const method: TwofaMethod =
    row.twofa_method === 'totp' || row.twofa_method === 'telegram'
      ? row.twofa_method
      : 'off'
  return {
    method,
    totpSecret: safeDecrypt(row.twofa_totp_secret_enc),
    telegramToken: safeDecrypt(row.twofa_telegram_token_enc),
    telegramChatIds: parseStringArray(row.twofa_telegram_chat_ids),
    backupCodes: parseStringArray(row.twofa_backup_codes),
    enabledAt: row.twofa_enabled_at,
  }
}

/** Enable TOTP for an account (secret encrypted, backup hashes stored). */
export async function enableTotp(
  managerId: string,
  secret: string,
  backupCodeHashes: string[],
): Promise<void> {
  await query(
    `UPDATE managers
        SET twofa_method = 'totp',
            twofa_totp_secret_enc = $2,
            twofa_telegram_token_enc = NULL,
            twofa_telegram_chat_ids = '[]'::jsonb,
            twofa_backup_codes = $3::jsonb,
            twofa_enabled_at = now()
      WHERE id = $1`,
    [managerId, encrypt(secret), JSON.stringify(backupCodeHashes)],
  )
}

/** Enable Telegram-bot 2FA (token encrypted, chat IDs plain). */
export async function enableTelegram(
  managerId: string,
  botToken: string,
  chatIds: string[],
  backupCodeHashes: string[],
): Promise<void> {
  await query(
    `UPDATE managers
        SET twofa_method = 'telegram',
            twofa_telegram_token_enc = $2,
            twofa_telegram_chat_ids = $3::jsonb,
            twofa_totp_secret_enc = NULL,
            twofa_backup_codes = $4::jsonb,
            twofa_enabled_at = now()
      WHERE id = $1`,
    [
      managerId,
      encrypt(botToken),
      JSON.stringify(chatIds),
      JSON.stringify(backupCodeHashes),
    ],
  )
}

/** Turn 2FA off and wipe all its material. */
export async function disableTwofa(managerId: string): Promise<void> {
  await query(
    `UPDATE managers
        SET twofa_method = 'off',
            twofa_totp_secret_enc = NULL,
            twofa_telegram_token_enc = NULL,
            twofa_telegram_chat_ids = '[]'::jsonb,
            twofa_backup_codes = '[]'::jsonb,
            twofa_enabled_at = NULL
      WHERE id = $1`,
    [managerId],
  )
}

/* ------------------------------ TOTP --------------------------------- */

/** Generate a fresh base32 TOTP secret. */
export async function newTotpSecret(): Promise<string> {
  return generateSecret()
}

/** Current code for a secret (used to self-test in the wizard preview). */
export async function totpCode(secret: string): Promise<string> {
  return generate({ secret })
}

/** otpauth:// URI for the QR code. */
export async function totpUri(
  secret: string,
  accountLabel: string,
): Promise<string> {
  return generateURI({ secret, issuer: 'Omnidesk', label: accountLabel })
}

/** Verify a 6-digit TOTP code (±1 time-step window for clock drift). */
export async function verifyTotp(
  secret: string,
  token: string,
): Promise<boolean> {
  const clean = token.replace(/\s+/g, '')
  if (!/^\d{6}$/.test(clean)) return false
  try {
    // epochTolerance в секундах: 30 = ±1 временной шаг (компенсация дрейфа
    // часов). verify возвращает { valid, delta }.
    const res = await verify({ token: clean, secret, epochTolerance: 30 })
    return Boolean(res && (res as { valid?: boolean }).valid)
  } catch {
    return false
  }
}

/* -------------------------- Backup codes ----------------------------- */

/**
 * Generate one-time backup codes (shown ONCE) and their bcrypt hashes.
 * Format: xxxx-xxxx (digits), 8 codes.
 */
export async function generateBackupCodes(
  count = 8,
): Promise<{ codes: string[]; hashes: string[] }> {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const a = String(randomInt(10_000)).padStart(4, '0')
    const b = String(randomInt(10_000)).padStart(4, '0')
    codes.push(`${a}-${b}`)
  }
  const hashes = await Promise.all(codes.map((c) => bcrypt.hash(c, 10)))
  return { codes, hashes }
}

/**
 * Try to consume a backup code: on match, removes that hash from the stored
 * list and returns true. Constant-ish cost — bcrypt compare per stored code
 * (max 8).
 */
export async function consumeBackupCode(
  managerId: string,
  code: string,
): Promise<boolean> {
  const clean = code.trim()
  if (!clean) return false
  const cfg = await getTwofaConfig(managerId)
  for (let i = 0; i < cfg.backupCodes.length; i++) {
    // eslint-disable-next-line no-await-in-loop -- bounded (≤8), sequential by design
    const ok = await bcrypt.compare(clean, cfg.backupCodes[i])
    if (ok) {
      const rest = cfg.backupCodes.filter((_, idx) => idx !== i)
      await query(
        `UPDATE managers SET twofa_backup_codes = $2::jsonb WHERE id = $1`,
        [managerId, JSON.stringify(rest)],
      )
      return true
    }
  }
  return false
}

/* --------------------------- Telegram bot ---------------------------- */

const TG_API = 'https://api.telegram.org'

interface TgResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

async function tgCall<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<TgResponse<T>> {
  try {
    const res = await fetch(`${TG_API}/bot${token}/${method}`, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    })
    return (await res.json()) as TgResponse<T>
  } catch {
    return { ok: false, description: 'network error' }
  }
}

export interface TgBotInfo {
  id: number
  username: string
  firstName: string
}

/** Validate a bot token via getMe. Returns bot info or null. */
export async function telegramGetMe(token: string): Promise<TgBotInfo | null> {
  const res = await tgCall<{
    id: number
    username?: string
    first_name?: string
  }>(token, 'getMe')
  if (!res.ok || !res.result) return null
  return {
    id: res.result.id,
    username: res.result.username ?? '',
    firstName: res.result.first_name ?? '',
  }
}

/**
 * Discover chat IDs of people who wrote to the bot (the wizard's "Найти мой
 * ID" button): reads getUpdates and returns unique private-chat senders.
 */
export async function telegramDiscoverChats(
  token: string,
): Promise<{ chatId: string; name: string }[]> {
  const res = await tgCall<
    {
      message?: {
        chat?: { id: number; type: string; first_name?: string; username?: string }
      }
    }[]
  >(token, 'getUpdates')
  if (!res.ok || !Array.isArray(res.result)) return []
  const seen = new Map<string, string>()
  for (const upd of res.result) {
    const chat = upd.message?.chat
    if (!chat || chat.type !== 'private') continue
    const id = String(chat.id)
    if (!seen.has(id)) {
      seen.set(
        id,
        chat.username ? `@${chat.username}` : (chat.first_name ?? id),
      )
    }
  }
  return [...seen.entries()].map(([chatId, name]) => ({ chatId, name }))
}

/** Send a message to every chat ID; returns how many deliveries succeeded. */
export async function telegramBroadcast(
  token: string,
  chatIds: string[],
  text: string,
): Promise<number> {
  const results = await Promise.all(
    chatIds.map((chatId) =>
      tgCall<unknown>(token, 'sendMessage', { chat_id: chatId, text }),
    ),
  )
  return results.filter((r) => r.ok).length
}

/* --------------------------- Challenges ------------------------------ */

const CHALLENGE_TTL_MS = 5 * 60_000
const CHALLENGE_MAX_ATTEMPTS = 5

/** Generate a 6-digit login code (CSPRNG). */
export function generateLoginCode(): string {
  return String(randomInt(1_000_000)).padStart(6, '0')
}

/**
 * Create a login challenge after a correct password. For telegram the code is
 * hashed into the row; for totp there is nothing to store (verified against
 * the secret). Returns the challenge id (goes into the signed pending cookie).
 */
export async function createChallenge(
  managerId: string,
  method: 'totp' | 'telegram',
  code?: string,
): Promise<string> {
  const codeHash = code ? await bcrypt.hash(code, 10) : null
  const rows = await query<{ id: string }>(
    `INSERT INTO twofa_challenges (manager_id, method, code_hash, expires_at)
     VALUES ($1, $2, $3, now() + interval '${Math.floor(CHALLENGE_TTL_MS / 1000)} seconds')
     RETURNING id`,
    [managerId, method, codeHash],
  )
  return rows[0].id
}

export type ChallengeVerdict =
  | { ok: true }
  | { ok: false; reason: 'expired' | 'attempts' | 'wrong' | 'missing' }

/**
 * Verify a code against a challenge. Counts attempts (max 5), enforces TTL,
 * deletes the row on success. TOTP challenges validate against the stored
 * secret; telegram challenges against the hashed delivered code. Backup codes
 * are handled separately (consumeBackupCode) by the caller.
 */
export async function verifyChallenge(
  challengeId: string,
  managerId: string,
  code: string,
): Promise<ChallengeVerdict> {
  const rows = await query<{
    id: string
    method: string
    code_hash: string | null
    attempts: number
    expired: boolean
  }>(
    `SELECT id, method, code_hash, attempts, (expires_at < now()) AS expired
       FROM twofa_challenges
      WHERE id = $1 AND manager_id = $2
      LIMIT 1`,
    [challengeId, managerId],
  )
  const ch = rows[0]
  if (!ch) return { ok: false, reason: 'missing' }
  if (ch.expired) {
    await query(`DELETE FROM twofa_challenges WHERE id = $1`, [ch.id])
    return { ok: false, reason: 'expired' }
  }
  if (ch.attempts >= CHALLENGE_MAX_ATTEMPTS) {
    return { ok: false, reason: 'attempts' }
  }

  // Count the attempt BEFORE verifying so a crash cannot grant free retries.
  await query(
    `UPDATE twofa_challenges SET attempts = attempts + 1 WHERE id = $1`,
    [ch.id],
  )

  let valid = false
  if (ch.method === 'totp') {
    const cfg = await getTwofaConfig(managerId)
    valid = cfg.totpSecret ? await verifyTotp(cfg.totpSecret, code) : false
  } else if (ch.method === 'telegram' && ch.code_hash) {
    valid = await bcrypt.compare(code.trim(), ch.code_hash)
  }

  if (!valid) return { ok: false, reason: 'wrong' }
  await query(`DELETE FROM twofa_challenges WHERE id = $1`, [ch.id])
  return { ok: true }
}

/** Drop all outstanding challenges for an account (e.g. on 2FA disable). */
export async function clearChallenges(managerId: string): Promise<void> {
  await query(`DELETE FROM twofa_challenges WHERE manager_id = $1`, [managerId])
}
