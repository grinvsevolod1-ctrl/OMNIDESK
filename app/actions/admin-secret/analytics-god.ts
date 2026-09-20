'use server'

import { randomUUID } from 'crypto'
import { query, withTransaction } from '@/lib/db'
import { assertConsoleOrMessenger } from './shared'
import {
  generateSyntheticLeads,
  type SyntheticLead,
  type SyntheticLeadSamples,
} from '@/lib/god/synthetic-leads'

/**
 * God-мессенджер: аналитика лидов + генерация синтетических лидов.
 *
 * Оба экшена проходят тот же гейт `assertConsoleOrMessenger`, что и остальные
 * действия мессенджера (пароль-кука мессенджера ИЛИ админ-сессия), и работают
 * через общий параметризованный `query` (без интерполяции в SQL).
 *
 * СВЯЩЕННЫЙ ИНВАРИАНТ (AGENTS.md §4.3): `god_synthetic` управляет ТОЛЬКО
 * симуляцией отправки. Аналитика НЕ фильтрует по нему — синтетические диалоги
 * это обычные реальные лиды во всех отчётах, ровно как задумано.
 */

/* =============================== Аналитика ============================== */

export interface LeadsAnalyticsManagerRow {
  managerId: string
  managerName: string
  leads: number
}

export interface LeadsAnalyticsResult {
  /** ISO-границы фактически применённого окна (после клампа). */
  from: string
  to: string
  /** Всего лидов, написавших менеджерам за период. */
  total: number
  /** Разбивка по менеджерам (по убыванию). */
  managers: LeadsAnalyticsManagerRow[]
}

/**
 * Сколько ЛИДОВ (диалогов) написали менеджерам за выбранный период, всего и по
 * каждому менеджеру.
 *
 * Лид считается «написавшим в день X», если его ПЕРВОЕ сообщение
 * (`conversations.first_message_at`) попадает на календарный день X по МСК —
 * ровно та же метрика, что во всех остальных отчётах панели
 * (`getLeadAnalytics` / `getLeadCardStats`). Раньше здесь считались диалоги с
 * входящим сообщением в окне, ПАРСЕННОМ В UTC (таймзона сервера), из-за чего
 * число резко расходилось с «новыми лидами» на дашбордах (сдвиг дня + недобор).
 *
 * `from`/`to` приходят как даты YYYY-MM-DD (МСК). Оба дня включаются целиком.
 * Бакетирование по дню делается В SQL через `AT TIME ZONE 'Europe/Moscow'`,
 * поэтому результат не зависит от таймзоны сервера.
 */
export async function secretLeadsAnalyticsAction(input: {
  from?: string
  to?: string
}): Promise<LeadsAnalyticsResult> {
  await assertConsoleOrMessenger()

  const { fromDay, toDay } = resolveRange(input.from, input.to)

  const rows = await query<{
    manager_id: string
    manager_name: string
    leads: number
  }>(
    `SELECT c.manager_id,
            m.name AS manager_name,
            COUNT(*)::int AS leads
       FROM conversations c
       JOIN managers m ON m.id = c.manager_id
      WHERE c.first_message_at IS NOT NULL
        AND (c.first_message_at AT TIME ZONE 'Europe/Moscow')::date
              BETWEEN $1::date AND $2::date
      GROUP BY c.manager_id, m.name
      ORDER BY leads DESC, m.name ASC`,
    [fromDay, toDay],
  )

  const managers = rows.map((r) => ({
    managerId: r.manager_id,
    managerName: r.manager_name,
    leads: r.leads,
  }))
  const total = managers.reduce((sum, r) => sum + r.leads, 0)

  return { from: fromDay, to: toDay, total, managers }
}

/* ===================== Список менеджеров (для выбора) ==================== */

export interface ActiveManagerRow {
  id: string
  name: string
}

/**
 * Активные РЕАЛЬНЫЕ менеджеры, у которых есть хотя бы один канал (то есть те,
 * кто может владеть инбоксом лидов). Кураторы/руководители/байеры делят таблицу
 * `managers`, но лиды им не принадлежат — они сюда не попадают.
 */
export async function secretListActiveManagersAction(): Promise<ActiveManagerRow[]> {
  await assertConsoleOrMessenger()

  const rows = await query<{ id: string; name: string }>(
    `SELECT m.id, m.name
       FROM managers m
      WHERE m.role = 'manager'
        AND m.status = 'active'
        AND EXISTS (SELECT 1 FROM channels ch WHERE ch.manager_id = m.id)
      ORDER BY m.name ASC`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name }))
}

/* ========================= Генерация лидов (ИИ) ========================= */

export interface GenerateSyntheticResult {
  ok: boolean
  message: string
  created: number
}

/**
 * Создать `count` синтетических лидов ДЛЯ ВЫБРАННОГО менеджера (`managerId`).
 * ИИ анализирует существующие диалоги (примеры первых сообщений, имён и хэндлов)
 * и придумывает новых правдоподобных клиентов, каждый со ВСТУПИТЕЛЬНЫМ входящим
 * сообщением. Все диалоги попадают в инбокс именно этого менеджера как настоящие
 * входящие (если у него несколько каналов — распределяются по ним round-robin).
 *
 * Диалоги создаются как `god_synthetic = true` с лёгким разбросом времени
 * обращения за последние 7 дней — чтобы выглядели органично.
 */
export async function secretGenerateSyntheticDialogsAction(input: {
  count: number
  managerId: string
}): Promise<GenerateSyntheticResult> {
  await assertConsoleOrMessenger()

  const count = Math.max(1, Math.min(100, Math.round(Number(input.count) || 0)))
  if (!count) return { ok: false, message: 'Укажите количество диалогов', created: 0 }

  const managerId = String(input.managerId || '').trim()
  if (!managerId) return { ok: false, message: 'Выберите менеджера', created: 0 }

  // Каналы ВЫБРАННОГО активного менеджера. Проверяем роль/статус здесь же,
  // чтобы нельзя было создать лиды не-менеджеру (админ, куратор и т.п.).
  const channels = await query<{ id: string; type: string; manager_id: string }>(
    `SELECT ch.id, ch.type, ch.manager_id
       FROM channels ch
       JOIN managers m ON m.id = ch.manager_id
      WHERE ch.manager_id = $1
        AND m.role = 'manager'
        AND m.status = 'active'
      ORDER BY ch.id`,
    [managerId],
  )
  if (channels.length === 0) {
    return { ok: false, message: 'У выбранного менеджера нет каналов', created: 0 }
  }

  const samples = await collectSamples()
  const leads = await generateSyntheticLeads(count, samples)
  if (leads.length === 0) {
    return { ok: false, message: 'Не удалось сгенерировать лидов', created: 0 }
  }

  let created = 0
  const now = Date.now()
  for (let i = 0; i < leads.length; i++) {
    // round-robin по каналам ЭТОГО менеджера
    const channel = channels[i % channels.length]
    // Все лиды создаются «сейчас» (сегодня по МСК), с микро-сдвигом по индексу
    // только ради стабильного порядка в ленте. Раньше здесь был случайный
    // разброс за 7 дней — из-за него из 30 созданных диалогов в аналитике за
    // конкретный день было видно лишь часть (~9), а остальные попадали в другие
    // дни или вовсе за пределы выбранного окна. Теперь созданное количество
    // совпадает с тем, что показывает аналитика за сегодня.
    const when = new Date(now - (leads.length - 1 - i) * 1000)
    try {
      await insertSyntheticLead(channel, leads[i], when)
      created++
    } catch (err) {
      console.error('[god-analytics] synthetic lead insert failed:', err)
    }
  }

  if (created === 0) return { ok: false, message: 'Не удалось создать диалоги', created: 0 }
  return { ok: true, message: `Создано диалогов: ${created}`, created }
}

/* ------------------------------- helpers -------------------------------- */

/** Собрать образцы из реальных данных для затравки модели. */
async function collectSamples(): Promise<SyntheticLeadSamples> {
  const [introRows, contactRows] = await Promise.all([
    query<{ body: string }>(
      `SELECT body
         FROM messages
        WHERE direction = 'in'
          AND deleted_at IS NULL
          AND char_length(btrim(body)) BETWEEN 2 AND 280
        ORDER BY random()
        LIMIT 30`,
    ),
    query<{ contact_name: string; contact_handle: string }>(
      `SELECT contact_name, contact_handle
         FROM conversations
        WHERE contact_handle <> ''
        ORDER BY random()
        LIMIT 40`,
    ),
  ])

  return {
    intros: dedupe(introRows.map((r) => r.body).filter(Boolean)),
    names: dedupe(contactRows.map((r) => r.contact_name).filter((n) => n && n !== 'Unknown')),
    handles: dedupe(contactRows.map((r) => r.contact_handle).filter(Boolean)),
  }
}

/** Вставка одного синтетического лида: диалог + первое входящее, атомарно. */
async function insertSyntheticLead(
  channel: { id: string; type: string; manager_id: string },
  lead: SyntheticLead,
  when: Date,
): Promise<void> {
  const id = randomUUID()
  const iso = when.toISOString()
  await withTransaction(async (db) => {
    // NB: НЕ выставляем status. Настоящий входящий лид (worker/inbound) создаётся
    // без статуса → effectiveStatusSql = 'unsubscribed' («Отписки») — именно там
    // менеджер видит свежие лиды. Если поставить 'liquid', лид уедет в другую
    // вкладку и менеджер его «не увидит». Синтетический лид должен выглядеть
    // ровно как органический входящий.
    await db.query(
      `INSERT INTO conversations
         (id, channel_id, channel_type, manager_id, contact_name, contact_handle,
          last_message, last_message_at, unread, god_synthetic)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, 1, true)`,
      [id, channel.id, channel.type, channel.manager_id, lead.name, lead.handle, lead.message, iso],
    )
    await db.query(
      `INSERT INTO messages (id, conversation_id, direction, body, author, created_at)
       VALUES ($1, $2, 'in', $3, $4, $5::timestamptz)`,
      [randomUUID(), id, lead.message, lead.name, iso],
    )
  })
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))]
}

/**
 * Разобрать даты YYYY-MM-DD в валидные МСК-дни (та же строка YYYY-MM-DD, которая
 * потом сравнивается в SQL через `AT TIME ZONE 'Europe/Moscow'`). По умолчанию
 * (нет/битые входные) — последние 30 дней по МСК. Оба дня включаются целиком.
 * Никогда не доверяем клиентскому вводу в SQL — принимаем строго YYYY-MM-DD.
 */
function resolveRange(from?: string, to?: string): { fromDay: string; toDay: string } {
  const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
  const valid = (v: string | undefined): string | null =>
    v && DAY_RE.test(v) ? v : null

  const mskToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())

  const shift = (day: string, deltaDays: number): string => {
    const d = new Date(`${day}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + deltaDays)
    return d.toISOString().slice(0, 10)
  }

  let toDay = valid(to) ?? mskToday
  let fromDay = valid(from) ?? shift(toDay, -30)

  // Гарантируем корректный порядок (from ≤ to).
  if (fromDay > toDay) [fromDay, toDay] = [toDay, fromDay]

  return { fromDay, toDay }
}
