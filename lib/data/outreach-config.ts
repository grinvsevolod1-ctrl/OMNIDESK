/**
 * Настройки исходящего контура в app_settings (jsonb key-value).
 *
 * Хранит:
 *   * outreach.bot — токен бота-приёмника лидов (зашифрован) + username +
 *     секрет вебхука (для X-Telegram-Bot-Api-Secret-Token);
 *   * outreach.warmup — параметры прогрева и лимиты (правятся из админки без
 *     деплоя, воркер перечитывает на каждом тике).
 */
import { query } from '../db'
import { encrypt, decrypt } from '../crypto'

const BOT_KEY = 'outreach.bot'
const WARMUP_KEY = 'outreach.warmup'

/* ------------------------------- Бот лидов -------------------------------- */

export interface OutreachBotConfig {
  /** Установлен ли токен (сам токен наружу не отдаём). */
  hasToken: boolean
  username: string
  /** Секрет вебхука установлен. */
  hasWebhookSecret: boolean
}

interface BotStored {
  tokenEnc?: string
  username?: string
  webhookSecret?: string
}

async function readBot(): Promise<BotStored> {
  const rows = await query<{ value: BotStored }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [BOT_KEY],
  )
  return rows[0]?.value ?? {}
}

async function writeBot(next: BotStored): Promise<void> {
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [BOT_KEY, JSON.stringify(next)],
  )
}

export async function getBotConfig(): Promise<OutreachBotConfig> {
  const s = await readBot()
  return {
    hasToken: Boolean(s.tokenEnc),
    username: s.username ?? '',
    hasWebhookSecret: Boolean(s.webhookSecret),
  }
}

/** Установить токен бота (шифруется) и опционально username. */
export async function setBotToken(
  token: string,
  username?: string,
): Promise<void> {
  const current = await readBot()
  const t = token.trim()
  if (!t) throw new Error('Токен пуст')
  await writeBot({
    ...current,
    tokenEnc: encrypt(t),
    username: (username ?? current.username ?? '').trim(),
    // Секрет вебхука генерируем при первой установке токена, если ещё нет.
    webhookSecret: current.webhookSecret ?? cryptoRandomSecret(),
  })
}

export async function clearBotToken(): Promise<void> {
  await writeBot({})
}

/** Расшифрованный токен + секрет вебхука (для API-роута/установки вебхука). */
export async function getBotSecrets(): Promise<{
  token: string
  webhookSecret: string
} | null> {
  const s = await readBot()
  if (!s.tokenEnc) return null
  try {
    return {
      token: decrypt(s.tokenEnc),
      webhookSecret: s.webhookSecret ?? '',
    }
  } catch {
    return null
  }
}

function cryptoRandomSecret(): string {
  // 32 hex-символа — достаточно для секрета вебхука Telegram.
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/* -------------------------------- Прогрев --------------------------------- */

export interface WarmupConfig {
  /** Дней пассивной фазы (вступления/чтение/реакции, без исходящих чужим). */
  passiveDays: number
  /** Дней взаимного прогрева между аккаунтами пула. */
  mutualDays: number
  /** С какого дня прогрева разрешены боевые касания лидам. */
  liveFromDay: number
  /** Рамп дневного капа боевых касаний по дням после liveFromDay. */
  dailyCapRamp: number[]
  /** Часовой кап отправок. */
  hourlyCap: number
  /** Окно активных часов (МСК), [начало, конец) в часах. */
  activeHoursStart: number
  activeHoursEnd: number
  /** Человеческая пауза между действиями, секунды [min, max]. */
  minDelaySec: number
  maxDelaySec: number
  /** Публичные группы для прогрева (вступления). */
  warmGroups: string[]
}

export const DEFAULT_WARMUP: WarmupConfig = {
  passiveDays: 3,
  mutualDays: 4,
  liveFromDay: 8,
  dailyCapRamp: [5, 10, 20, 30],
  hourlyCap: 6,
  activeHoursStart: 9,
  activeHoursEnd: 22,
  minDelaySec: 45,
  maxDelaySec: 120,
  warmGroups: [],
}

export async function getWarmupConfig(): Promise<WarmupConfig> {
  const rows = await query<{ value: Partial<WarmupConfig> }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [WARMUP_KEY],
  )
  return { ...DEFAULT_WARMUP, ...(rows[0]?.value ?? {}) }
}

export async function setWarmupConfig(
  patch: Partial<WarmupConfig>,
): Promise<WarmupConfig> {
  const current = await getWarmupConfig()
  const next: WarmupConfig = { ...current, ...patch }
  await query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [WARMUP_KEY, JSON.stringify(next)],
  )
  return next
}
