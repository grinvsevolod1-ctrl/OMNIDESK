import 'server-only'

/**
 * Рантайм ИИ-автопилота god-мессенджера.
 *
 * Что делает один tick (его дёргает крон, а также ручная кнопка «Прогнать»):
 *  1. Планировщик: на текущий рабочий день МСК раскидывает daily_target
 *     слотов на ХАОТИЧНЫЕ моменты внутри рабочего окна (один раз в день).
 *  2. Создание: берёт «доспевшие» слоты (fire_at <= now) и создаёт по ним
 *     новые ВХОДЯЩИЕ диалоги от имени случайной персоны в случайном выбранном
 *     канале. Первое сообщение генерит модель в характере персоны.
 *  3. Ведение: для активных диалогов, где менеджер ответил последним,
 *     генерит следующую реплику «клиента», пока не упрётся в max_turns —
 *     тогда диалог естественно закрывается.
 *
 * ИЗОЛЯЦИЯ (AGENTS.md §4): создаёт ОБЫЧНЫЕ реальные диалоги (те же таблицы,
 * что и живой чат), никакой пометки is_simulated. Никаких записей в
 * admin-видимый журнал аудита.
 */

import { randomUUID } from 'crypto'
import { query, withTransaction } from '@/lib/db'
import { APP_TIME_ZONE } from '@/lib/time'
import { getAutopilotConfig } from './config'
import { buildPersona, newId } from './personas'
import {
  generateOpeningMessage,
  generateClientReply,
  type AutopilotTurn,
} from './generate'
import type { AutopilotConfig, AutopilotPersona, AutopilotTickResult } from './types'

/** Минут от полуночи МСК для данного момента. */
function mskMinutesOfDay(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: APP_TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0')
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0')
  return hh * 60 + mm
}

/** Ключ дня МСК (YYYY-MM-DD). */
function mskDayKey(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: APP_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

/** true, если сейчас внутри рабочего окна МСК. */
function insideWindow(now: Date, cfg: AutopilotConfig): boolean {
  const m = mskMinutesOfDay(now)
  return m >= cfg.workStartMin && m < cfg.workEndMin
}

/**
 * Абсолютный UTC-момент для «минуты X дня МСК = сегодня». MSK — фиксированный
 * UTC+3 без перехода на летнее время, поэтому смещение стабильно.
 */
function mskMinuteToUtc(now: Date, minuteOfDay: number): Date {
  const dayKey = mskDayKey(now) // YYYY-MM-DD в МСК
  const [y, mo, d] = dayKey.split('-').map(Number)
  const hh = Math.floor(minuteOfDay / 60)
  const mm = minuteOfDay % 60
  // Полночь этого МСК-дня в UTC = 21:00 предыдущих суток UTC (UTC+3).
  // Проще: строим момент как UTC и вычитаем 3 часа смещения.
  const asUtc = Date.UTC(y, mo - 1, d, hh, mm, 0)
  return new Date(asUtc - 3 * 60 * 60 * 1000)
}

/**
 * Шаг 1. Гарантировать, что на сегодня слоты запланированы. Планируем один
 * раз в день: если на сегодняшний МСК-день уже есть слоты, ничего не делаем.
 * Моменты выбираются хаотично внутри рабочего окна (равномерный шум), но
 * только в будущем относительно now, чтобы не выстрелить всё сразу.
 */
async function ensureTodaySlots(now: Date, cfg: AutopilotConfig): Promise<number> {
  const target = Math.max(0, Math.min(cfg.dailyTarget, 200))
  if (target === 0) return 0

  // Границы сегодняшнего рабочего окна в UTC.
  const windowStartUtc = mskMinuteToUtc(now, cfg.workStartMin)
  const windowEndUtc = mskMinuteToUtc(now, cfg.workEndMin)

  // Уже есть слоты, попадающие в сегодняшнее окно? Тогда день распланирован.
  const existing = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM god_ai_slots
      WHERE fire_at >= $1 AND fire_at < $2`,
    [windowStartUtc.toISOString(), windowEndUtc.toISOString()],
  )
  if (Number(existing[0]?.n ?? '0') > 0) return 0

  // Планируем только оставшуюся часть окна (от max(now, начало) до конца).
  const fromMs = Math.max(now.getTime(), windowStartUtc.getTime())
  const toMs = windowEndUtc.getTime()
  if (toMs <= fromMs) return 0

  const fireTimes: Date[] = []
  for (let k = 0; k < target; k++) {
    const t = fromMs + Math.random() * (toMs - fromMs)
    fireTimes.push(new Date(Math.floor(t)))
  }
  fireTimes.sort((a, b) => a.getTime() - b.getTime())

  await withTransaction(async (db) => {
    for (const t of fireTimes) {
      await db.query(
        `INSERT INTO god_ai_slots (id, fire_at, done) VALUES ($1, $2, false)`,
        [newId(), t.toISOString()],
      )
    }
  })
  return fireTimes.length
}

/** Случайный канал из выбранных, у которого есть владелец-менеджер. */
async function pickChannel(
  channelIds: string[],
): Promise<{ id: string; type: string; manager_id: string } | null> {
  if (channelIds.length === 0) return null
  const rows = await query<{ id: string; type: string; manager_id: string | null }>(
    `SELECT id, type, manager_id FROM channels
      WHERE id = ANY($1::uuid[]) AND manager_id IS NOT NULL`,
    [channelIds],
  )
  const usable = rows.filter((r): r is { id: string; type: string; manager_id: string } =>
    Boolean(r.manager_id),
  )
  if (usable.length === 0) return null
  return usable[Math.floor(Math.random() * usable.length)]
}

/** Результат попытки создать один диалог. */
type CreateOutcome = 'created' | 'no_channel' | 'no_message'

/**
 * Создать один входящий диалог (общая логика для слотов и форс-прогона).
 * Возвращает причину неудачи, чтобы её можно было показать владельцу.
 */
async function createDialog(
  cfg: AutopilotConfig,
  slotId: string | null,
): Promise<CreateOutcome> {
  const channel = await pickChannel(cfg.channelIds)
  if (!channel) return 'no_channel'

  const persona = buildPersona()
  const opening =
    (await generateOpeningMessage(cfg.topic, persona, cfg.model)) ?? null
  if (!opening) return 'no_message'

  const convId = randomUUID()
  await withTransaction(async (db) => {
    await db.query(
      `INSERT INTO conversations
         (id, channel_id, channel_type, manager_id, contact_name, contact_handle,
          last_message, last_message_at, status, unread)
       VALUES ($1,$2,$3,$4,$5,$6,$7, now(), 'liquid', 1)`,
      [
        convId,
        channel.id,
        channel.type,
        channel.manager_id,
        persona.name,
        persona.handle,
        opening,
      ],
    )
    await db.query(
      `INSERT INTO messages (id, conversation_id, direction, body, author, created_at)
       VALUES ($1,$2,'in',$3,$4, now())`,
      [randomUUID(), convId, opening, persona.name],
    )
    await db.query(
      `INSERT INTO god_ai_threads
         (conversation_id, persona, active, turns, max_turns)
       VALUES ($1, $2::jsonb, true, 1, $3)`,
      [convId, JSON.stringify(persona), cfg.maxTurns],
    )
    if (slotId) {
      await db.query(
        `UPDATE god_ai_slots SET done = true, conversation_id = $2 WHERE id = $1`,
        [slotId, convId],
      )
    }
  })
  return 'created'
}

/**
 * Шаг 2. Отработать «доспевшие» слоты. Ограничиваем пачку, чтобы один tick не
 * висел вечно — остальные подхватит следующий прогон.
 */
async function processDueSlots(
  now: Date,
  cfg: AutopilotConfig,
  limit: number,
): Promise<number> {
  const due = await query<{ id: string }>(
    `SELECT id FROM god_ai_slots
      WHERE NOT done AND fire_at <= $1
      ORDER BY fire_at ASC
      LIMIT $2`,
    [now.toISOString(), limit],
  )
  let created = 0
  for (const slot of due) {
    try {
      const outcome = await createDialog(cfg, slot.id)
      if (outcome === 'created') created++
      else {
        // Нет пригодного канала или модель промолчала — не зацикливаемся,
        // помечаем слот отработанным, чтобы он не залипал.
        await query(`UPDATE god_ai_slots SET done = true WHERE id = $1`, [slot.id])
      }
    } catch (err) {
      console.warn('[god-autopilot] createDialog (slot) failed:', err)
    }
  }
  return created
}

/**
 * Форс-создание диалогов для ручного «Прогнать сейчас»: не ждёт «доспевания»
 * слотов и не смотрит на рабочее окно. Потребляет ближайшие невыполненные
 * слоты (чтобы не раздувать дневную норму), а если их нет — создаёт диалог
 * без слота. Возвращает число созданных и последнюю причину неудачи.
 */
async function forceCreateDialogs(
  cfg: AutopilotConfig,
  count: number,
): Promise<{ created: number; failReason: CreateOutcome | null }> {
  const slots = await query<{ id: string }>(
    `SELECT id FROM god_ai_slots
      WHERE NOT done
      ORDER BY fire_at ASC
      LIMIT $1`,
    [count],
  )
  let created = 0
  let failReason: CreateOutcome | null = null
  for (let k = 0; k < count; k++) {
    const slotId = slots[k]?.id ?? null
    try {
      const outcome = await createDialog(cfg, slotId)
      if (outcome === 'created') created++
      else {
        failReason = outcome
        // Канал так и не появится и модель не заговорит в этом же прогоне —
        // дальше долбить бессмысленно.
        break
      }
    } catch (err) {
      console.warn('[god-autopilot] createDialog (force) failed:', err)
      failReason = 'no_message'
      break
    }
  }
  return { created, failReason }
}

interface ActiveThreadRow {
  conversation_id: string
  persona: unknown
  turns: number
  max_turns: number
  /** Когда менеджер написал последнее сообщение (ждём «человеческую» паузу). */
  last_out_at: string
}

/**
 * Детерминированный 32-битный хэш (FNV-1a). Нужен, чтобы пауза перед ответом
 * была случайной, но СТАБИЛЬНОЙ между тиками крона: без него каждый тик
 * перебрасывал бы кубик заново и паузы бы не работали.
 */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/**
 * Сколько секунд «клиент» выжидает перед ответом на конкретную реплику
 * менеджера. Похоже на живого человека: обычно 1–7 минут (прочитал, подумал,
 * напечатал), но примерно каждый четвёртый ответ — «отвлёкся» на 10–35 минут.
 * Детерминировано по (диалог, номер хода), поэтому не меняется между тиками.
 */
function replyDelaySec(conversationId: string, turns: number): number {
  const h = fnv1a(`${conversationId}:${turns}`)
  const roll = h % 100
  if (roll < 25) {
    // «Отвлёкся»: 10–35 минут.
    return 600 + (h % 1500)
  }
  // Обычный темп: 60–420 секунд.
  return 60 + (h % 360)
}

function toPersona(value: unknown): AutopilotPersona | null {
  if (value && typeof value === 'object') return value as AutopilotPersona
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as AutopilotPersona
    } catch {
      return null
    }
  }
  return null
}

/**
 * Шаг 3. Продолжить активные диалоги, где менеджер ответил последним. Клиент
 * отвечает одной репликой; при достижении max_turns диалог закрывается.
 */
async function processActiveThreads(
  cfg: AutopilotConfig,
  limit: number,
): Promise<number> {
  if (!cfg.replyEnabled) return 0

  // Активные автопилот-диалоги, где ПОСЛЕДНЕЕ сообщение исходящее (менеджер),
  // то есть ждут ответа клиента. Забираем и время этого сообщения — от него
  // отсчитывается «человеческая» пауза перед ответом.
  const threads = await query<ActiveThreadRow>(
    `SELECT t.conversation_id, t.persona, t.turns, t.max_turns,
            lm.created_at AS last_out_at
       FROM god_ai_threads t
       JOIN LATERAL (
          SELECT m.direction, m.created_at FROM messages m
           WHERE m.conversation_id = t.conversation_id AND m.deleted_at IS NULL
           ORDER BY m.created_at DESC LIMIT 1
       ) lm ON true
      WHERE t.active AND lm.direction = 'out'
      ORDER BY t.created_at ASC
      LIMIT $1`,
    [limit],
  )

  const nowMs = Date.now()
  let replied = 0
  for (const t of threads) {
    const persona = toPersona(t.persona)
    if (!persona) continue

    // Пауза ещё не выдержана — человек «думает/занят», ответит на следующих
    // тиках. Пауза детерминирована, поэтому между тиками не перебрасывается.
    const waitedSec = (nowMs - new Date(t.last_out_at).getTime()) / 1000
    if (waitedSec < replyDelaySec(t.conversation_id, t.turns)) continue
    try {
      // Полная переписка для контекста модели.
      const msgs = await query<{ direction: 'in' | 'out'; body: string }>(
        `SELECT direction, body FROM messages
          WHERE conversation_id = $1 AND deleted_at IS NULL
          ORDER BY created_at ASC`,
        [t.conversation_id],
      )
      const history: AutopilotTurn[] = msgs.map((m) => ({
        role: m.direction === 'in' ? 'client' : 'manager',
        body: m.body,
      }))

      const reply = await generateClientReply(
        cfg.topic,
        persona,
        history,
        t.turns,
        t.max_turns,
        cfg.model,
      )
      if (!reply) continue

      const nextTurns = t.turns + 1
      const shouldClose = nextTurns >= t.max_turns
      await withTransaction(async (db) => {
        await db.query(
          `INSERT INTO messages (id, conversation_id, direction, body, author, created_at)
           VALUES ($1,$2,'in',$3,$4, now())`,
          [randomUUID(), t.conversation_id, reply, persona.name],
        )
        await db.query(
          `UPDATE conversations
              SET last_message = $2, last_message_at = now(), unread = unread + 1
            WHERE id = $1`,
          [t.conversation_id, reply],
        )
        await db.query(
          `UPDATE god_ai_threads
              SET turns = $2, active = $3
            WHERE conversation_id = $1`,
          [t.conversation_id, nextTurns, !shouldClose],
        )
      })
      replied++
    } catch (err) {
      console.warn('[god-autopilot] thread reply failed:', err)
    }
  }
  return replied
}

/**
 * Один полный прогон автопилота. Идемпотентен и безопасен для частого вызова:
 * дедуп слотов по дню, лимиты пачек и все проверки живут здесь, а не в
 * расписании.
 */
export async function runAutopilotTick(opts?: {
  maxCreate?: number
  maxReplies?: number
  /**
   * Форс-режим для ручного «Прогнать сейчас»: создать диалоги НЕМЕДЛЕННО,
   * не дожидаясь «доспевания» хаотичных слотов и игнорируя рабочее окно.
   */
  force?: boolean
}): Promise<AutopilotTickResult> {
  const cfg = await getAutopilotConfig()
  if (!cfg.enabled)
    return { planned: 0, created: 0, replied: 0, skipped: 'disabled' }
  if (cfg.channelIds.length === 0)
    return { planned: 0, created: 0, replied: 0, skipped: 'no_channels' }
  if (!process.env.AI_GATEWAY_API_KEY)
    return { planned: 0, created: 0, replied: 0, skipped: 'no_gateway_key' }

  const now = new Date()
  const maxCreate = Math.max(1, Math.min(opts?.maxCreate ?? 5, 25))
  const maxReplies = Math.max(1, Math.min(opts?.maxReplies ?? 15, 50))

  let planned = 0
  let created = 0
  let skipped: string | null = null

  if (opts?.force) {
    // Ручной прогон: планируем день (если ещё не), затем создаём сразу.
    if (insideWindow(now, cfg)) planned = await ensureTodaySlots(now, cfg)
    const res = await forceCreateDialogs(cfg, maxCreate)
    created = res.created
    if (created === 0 && res.failReason) {
      skipped =
        res.failReason === 'no_channel' ? 'no_usable_channel' : 'generation_failed'
    }
  } else if (insideWindow(now, cfg)) {
    // Крон: планируем и создаём новые диалоги только внутри окна МСК.
    planned = await ensureTodaySlots(now, cfg)
    created = await processDueSlots(now, cfg, maxCreate)
  }

  // Отвечать менеджеру можно всегда (менеджер мог написать и вне окна).
  const replied = await processActiveThreads(cfg, maxReplies)

  return { planned, created, replied, skipped }
}
