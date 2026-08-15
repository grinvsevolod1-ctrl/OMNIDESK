'use server'

import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { createChannel, enqueueJob, getChannelById } from '@/lib/data'
import { query } from '@/lib/db'
import { GmtApiError, gmtPurchaseDetails } from '@/lib/god-gmt'
import type { SessionStatus } from '@/lib/types'

/* ===================================================================== */
/*  Автоимпорт купленного в Get My TG номера в god-аккаунты (Telegram)    */
/*                                                                        */
/*  Мост между вкладкой «API TG» и вкладкой «Telegram»: превращает        */
/*  SUCCESS-покупку в личный telegram_personal-канал и запускает вход.    */
/*  Оркестрацией (код → 2FA → онлайн) дирижирует клиент, переиспользуя    */
/*  personal*-actions — здесь только создание канала и старт логина.      */
/* ===================================================================== */

/**
 * Гейт как во всей god-панели: admin-сессия И god-разблокировка, иначе 404.
 * Сознательно без audit() — admin-видимый журнал не знает о god-модулях
 * (СВЯЩЕННЫЙ ИНВАРИАНТ, AGENTS.md §4).
 */
async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

function humanizeGmtError(err: unknown): string {
  if (err instanceof GmtApiError) return err.message
  return 'Сервис Get My TG недоступен. Повторите позже.'
}

/** `+79991234567` из любого формата номера, либо null если мусор. */
function normalizePhone(raw: string | null): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^\d]/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return `+${digits}`
}

export interface GmtImportStart {
  channelId: string
  phone: string
  /** true — канал с этим номером уже существовал, переиспользуем его. */
  reused: boolean
  sessionStatus: SessionStatus
}

export type GmtImportResult<T> =
  | { ok: true; data: T }
  | { ok: false; message: string }

/**
 * Шаг 1 автоимпорта: по SUCCESS-покупке создаёт (или переиспользует) личный
 * канал с её номером и запускает вход по телефону. Дальше клиент дожимает
 * код и 2FA через personal*-actions.
 *
 * Идемпотентность: если канал с этим номером уже есть — возвращаем его,
 * повторную покупку/логин не плодим (частый кейс — повторный клик).
 */
export async function secretGmtImportStartAction(
  purchaseId: number,
): Promise<GmtImportResult<GmtImportStart>> {
  await requireGod()
  if (!Number.isInteger(purchaseId) || purchaseId < 1) {
    return { ok: false, message: 'Некорректный ID покупки' }
  }

  let purchase
  try {
    purchase = await gmtPurchaseDetails(purchaseId)
  } catch (err) {
    return { ok: false, message: humanizeGmtError(err) }
  }

  // Терминальные неудачи импортировать нельзя.
  if (purchase.status === 'ERROR' || purchase.status === 'REFUND') {
    return {
      ok: false,
      message:
        purchase.status === 'REFUND'
          ? 'Покупка возвращена — импорт невозможен.'
          : 'Покупка завершилась ошибкой — импорт невозможен.',
    }
  }
  // PENDING и SUCCESS импортируем одинаково: номер выдаётся сразу при покупке,
  // а код (переход в SUCCESS) прилетает позже — его дожимает сам флоу через
  // request-code. Требовать SUCCESS здесь было дедлоком: SUCCESS наступает
  // только ПОСЛЕ request-code, а request-code идёт шагом позже импорта.
  // У PENDING номер иногда появляется с задержкой в пару секунд — коротко ждём.
  let phone = normalizePhone(purchase.phone_number)
  for (let i = 0; i < 5 && !phone; i++) {
    await new Promise((r) => setTimeout(r, 2_000))
    try {
      purchase = await gmtPurchaseDetails(purchaseId)
    } catch {
      /* сеть моргнула — повторим на следующей итерации */
    }
    phone = normalizePhone(purchase.phone_number)
  }
  if (!phone) {
    return {
      ok: false,
      message: 'Сервис ещё не назначил номер. Повторите импорт через минуту.',
    }
  }

  // Дедуп по номеру: канал уже заведён — не создаём второй.
  const existing = await query<{ id: string; session_status: SessionStatus }>(
    `SELECT id, session_status
       FROM channels
      WHERE type = 'telegram_personal' AND phone = $1
      LIMIT 1`,
    [phone],
  )
  if (existing[0]) {
    return {
      ok: true,
      data: {
        channelId: existing[0].id,
        phone,
        reused: true,
        sessionStatus: existing[0].session_status,
      },
    }
  }

  const label = purchase.display_name?.ru?.trim()
  const channel = await createChannel({
    managerId: null,
    type: 'telegram_personal',
    name: label ? `${label} · ${phone}` : phone,
    detail: phone,
    status: 'pending',
    sessionStatus: 'starting',
    phone,
    proxyId: null,
    config: { gmtPurchaseId: purchaseId, source: 'getmytg' },
  })
  await enqueueJob({
    channelId: channel.id,
    managerId: null,
    action: 'start',
    payload: { phone, attemptId: globalThis.crypto.randomUUID() },
  })

  return {
    ok: true,
    data: { channelId: channel.id, phone, reused: false, sessionStatus: 'starting' },
  }
}

/**
 * Список номеров (E.164), которые уже заведены как личные каналы — для
 * бейджей «в god-аккаунтах» в истории покупок. Дешёвый одиночный запрос.
 */
export async function secretGmtImportedPhonesAction(): Promise<string[]> {
  await requireGod()
  const rows = await query<{ phone: string | null }>(
    `SELECT phone FROM channels
      WHERE type = 'telegram_personal' AND phone IS NOT NULL`,
  )
  return rows
    .map((r) => normalizePhone(r.phone))
    .filter((p): p is string => p !== null)
}

/**
 * Тонкий статус канала для оркестратора импорта (без DTO мессенджера).
 * Дублирует часть personalGetStatusAction, чтобы импорт не зависел от него.
 */
export async function secretGmtImportStatusAction(
  channelId: string,
): Promise<{ sessionStatus: SessionStatus; lastError: string | null } | null> {
  await requireGod()
  const channel = await getChannelById(channelId)
  if (!channel || channel.type !== 'telegram_personal') return null
  return { sessionStatus: channel.sessionStatus, lastError: channel.lastError }
}
