'use server'

import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  createChannel,
  deleteChannelById,
  enqueueJob,
  getChannelById,
  updateChannelSessionById,
} from '@/lib/data'
import { query } from '@/lib/db'
import { fetchTelegramQr, postJsonToWorker } from '@/lib/worker-client'
import type { SessionStatus } from '@/lib/types'

/* ===================================================================== */
/*  Личные Telegram-аккаунты — god-панель, вкладка «Telegram»             */
/* ===================================================================== */

/**
 * Гейт: admin-сессия И god-разблокировка. Личные аккаунты — часть скрытой
 * панели, поэтому голый requireAdmin недостаточен. Заблокированный или
 * ненастроенный гейт отвечает 404 — та же форма, что и сама страница.
 *
 * Сознательно НЕТ audit()-вызовов: admin-видимый журнал действий не должен
 * нести следов этого модуля (СВЯЩЕННЫЙ ИНВАРИАНТ, AGENTS.md §4).
 */
async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

/**
 * Скоуп: канал существует и это ИМЕННО личный аккаунт. Обычный telegram-канал
 * продавца через эти actions недоступен (и наоборот — личный недоступен через
 * admin-accounts actions, которые фильтруют type='telegram').
 */
async function requirePersonalChannel(channelId: string) {
  const channel = await getChannelById(channelId)
  if (!channel || channel.type !== 'telegram_personal') notFound()
  return channel
}

export interface PersonalAccountItem {
  id: string
  name: string
  detail: string
  phone: string | null
  sessionStatus: SessionStatus
  lastError: string | null
  createdAt: string
}

export interface PersonalActionResult {
  ok: boolean
  message: string
  channelId?: string
  sessionStatus?: SessionStatus
}

/** DTO мессенджера — зеркалит worker/src/personal.ts. */
export interface PersonalDialog {
  peerId: string
  title: string
  username: string | null
  kind: 'user' | 'group' | 'channel'
  unreadCount: number
  lastMessage: string
  lastMessageAt: number | null
  lastOutgoing: boolean
  hasAvatar: boolean
  verified: boolean
}

export interface PersonalMessage {
  id: string
  outgoing: boolean
  text: string
  date: number
  mediaType:
    | 'image'
    | 'video'
    | 'video_note'
    | 'audio'
    | 'voice'
    | 'sticker'
    | 'document'
    | null
  mediaMime: string | null
  mediaName: string | null
  editable: boolean
  replyToId: string | null
}

/* ------------------------------ Аккаунты ------------------------------ */

export async function personalListAccountsAction(): Promise<
  PersonalAccountItem[]
> {
  await requireGod()
  const rows = await query<{
    id: string
    name: string
    detail: string
    phone: string | null
    session_status: SessionStatus
    last_error: string | null
    created_at: string
  }>(
    `SELECT id, name, detail, phone, session_status, last_error, created_at
       FROM channels
      WHERE type = 'telegram_personal'
      ORDER BY created_at DESC`,
  )
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    detail: r.detail,
    phone: r.phone,
    sessionStatus: r.session_status,
    lastError: r.last_error,
    createdAt: String(r.created_at),
  }))
}

/**
 * Подключение по QR: канал + start_qr джоба. Без прокси-требования (личный
 * аккаунт владельца) и без manager-владельца (manager_id = NULL, миграция 135).
 */
export async function personalConnectQrAction(
  name: string,
): Promise<PersonalActionResult> {
  await requireGod()
  const channel = await createChannel({
    managerId: null,
    type: 'telegram_personal',
    name: name.trim() || 'Личный аккаунт',
    detail: 'QR-подключение',
    status: 'pending',
    sessionStatus: 'starting',
    phone: null,
    proxyId: null,
    config: {},
  })
  await enqueueJob({
    channelId: channel.id,
    managerId: null,
    action: 'start_qr',
    payload: { attemptId: globalThis.crypto.randomUUID() },
  })
  return {
    ok: true,
    message: 'Генерируем QR-код…',
    channelId: channel.id,
    sessionStatus: 'starting',
  }
}

/** Подключение по номеру телефона: канал + start джоба (код → 2FA). */
export async function personalConnectPhoneAction(
  name: string,
  rawPhone: string,
): Promise<PersonalActionResult> {
  await requireGod()
  const digits = rawPhone.replace(/[\s\-()]/g, '')
  if (!/^\+?[0-9]{7,15}$/.test(digits)) {
    return {
      ok: false,
      message: 'Введите корректный номер, например +14155550132.',
    }
  }
  const phone = digits.startsWith('+') ? digits : `+${digits}`
  const channel = await createChannel({
    managerId: null,
    type: 'telegram_personal',
    name: name.trim() || 'Личный аккаунт',
    detail: phone,
    status: 'pending',
    sessionStatus: 'starting',
    phone,
    proxyId: null,
    config: {},
  })
  await enqueueJob({
    channelId: channel.id,
    managerId: null,
    action: 'start',
    payload: { phone, attemptId: globalThis.crypto.randomUUID() },
  })
  return {
    ok: true,
    message: 'Запрашиваем код входа…',
    channelId: channel.id,
    sessionStatus: 'starting',
  }
}

/** Живой QR deep link (лежит только в памяти worker'а, ротация ~30с). */
export async function personalGetQrAction(
  channelId: string,
): Promise<{ qr: string | null; expiresAt: number | null }> {
  await requireGod()
  await requirePersonalChannel(channelId)
  const data = await fetchTelegramQr(channelId)
  return data ?? { qr: null, expiresAt: null }
}

/** Перезапуск QR-логина (истёк, logout, или телефонный флоу застрял). */
export async function personalRestartQrAction(
  channelId: string,
): Promise<PersonalActionResult> {
  await requireGod()
  const channel = await requirePersonalChannel(channelId)
  if (channel.sessionStatus === 'online') {
    return { ok: false, message: 'Аккаунт уже подключён.' }
  }
  await updateChannelSessionById(channelId, {
    sessionStatus: 'starting',
    lastError: null,
  })
  await enqueueJob({
    channelId,
    managerId: null,
    action: 'start_qr',
    payload: { attemptId: globalThis.crypto.randomUUID() },
  })
  return { ok: true, message: 'Генерируем QR-код…', channelId }
}

/** Повторный запрос кода на существующем канале (код истёк / не пришёл). */
export async function personalResendCodeAction(
  channelId: string,
): Promise<PersonalActionResult> {
  await requireGod()
  const channel = await requirePersonalChannel(channelId)
  if (!channel.phone) {
    return { ok: false, message: 'У аккаунта не указан номер телефона.' }
  }
  if (channel.sessionStatus === 'online') {
    return { ok: false, message: 'Аккаунт уже подключён.' }
  }
  await updateChannelSessionById(channelId, {
    sessionStatus: 'starting',
    lastError: null,
  })
  await enqueueJob({
    channelId,
    managerId: null,
    action: 'start',
    payload: {
      phone: channel.phone,
      attemptId: globalThis.crypto.randomUUID(),
    },
  })
  return { ok: true, message: 'Запрашиваем новый код входа…', channelId }
}

export async function personalSubmitCodeAction(
  channelId: string,
  code: string,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  await updateChannelSessionById(channelId, { sessionStatus: 'code_pending' })
  await enqueueJob({
    channelId,
    managerId: null,
    action: 'send_code',
    payload: { code: code.trim() },
  })
  return { ok: true, message: 'Проверяем код…', channelId }
}

export async function personalSubmitPasswordAction(
  channelId: string,
  password: string,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  await enqueueJob({
    channelId,
    managerId: null,
    action: 'send_password',
    payload: { password },
  })
  return { ok: true, message: 'Проверяем пароль…', channelId }
}

/** Снапшот статуса для поллинга мастера подключения. */
export async function personalGetStatusAction(channelId: string): Promise<{
  sessionStatus: SessionStatus
  lastError: string | null
  detail: string
  codeDelivery: 'app' | 'sms' | null
} | null> {
  await requireGod()
  const channel = await getChannelById(channelId)
  if (!channel || channel.type !== 'telegram_personal') return null
  const delivery = (channel.config as { codeDelivery?: unknown } | null)
    ?.codeDelivery
  return {
    sessionStatus: channel.sessionStatus,
    lastError: channel.lastError,
    detail: channel.detail,
    codeDelivery: delivery === 'app' || delivery === 'sms' ? delivery : null,
  }
}

/** Мягкая остановка: авторизация сохраняется, сессия уходит в offline. */
export async function personalStopAction(
  channelId: string,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  await enqueueJob({ channelId, managerId: null, action: 'stop' })
  return { ok: true, message: 'Останавливаем…', channelId }
}

/** Повторный запуск с сохранённой сессией. */
export async function personalStartAction(
  channelId: string,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  await updateChannelSessionById(channelId, {
    sessionStatus: 'starting',
    lastError: null,
  })
  await enqueueJob({ channelId, managerId: null, action: 'restart' })
  return { ok: true, message: 'Подключаем…', channelId }
}

/**
 * Полное отключение: logout-джоба отзывает авторизацию и стирает секреты,
 * затем канал удаляется. После logout в Telegram не остаётся нашей сессии.
 */
export async function personalDeleteAction(
  channelId: string,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  await enqueueJob({ channelId, managerId: null, action: 'logout' })
  // Даём воркеру шанс обработать logout до удаления строки канала; сама
  // джоба переживёт удаление (FK ON DELETE CASCADE удалит и её, поэтому
  // ждём здесь, а не удаляем сразу).
  await new Promise((r) => setTimeout(r, 3_000))
  await deleteChannelById(channelId)
  return { ok: true, message: 'Аккаунт отключён и удалён.' }
}

/* ----------------------------- Мессенджер ----------------------------- */

/** Живой список диалогов аккаунта. Ничего не пишется в БД. */
export async function personalDialogsAction(
  channelId: string,
): Promise<{ ok: boolean; dialogs: PersonalDialog[]; error?: string }> {
  await requireGod()
  await requirePersonalChannel(channelId)
  const data = await postJsonToWorkerSafeGet<{ dialogs: PersonalDialog[] }>(
    `/personal/dialogs?channelId=${encodeURIComponent(channelId)}`,
  )
  if (!data) return { ok: false, dialogs: [], error: 'Сессия недоступна' }
  return { ok: true, dialogs: data.dialogs ?? [] }
}

/** Живая страница истории одного диалога (beforeId — пагинация назад). */
export async function personalHistoryAction(
  channelId: string,
  peer: string,
  beforeId?: number,
): Promise<{ ok: boolean; messages: PersonalMessage[]; error?: string }> {
  await requireGod()
  await requirePersonalChannel(channelId)
  const params = new URLSearchParams({ channelId, peer })
  if (beforeId && beforeId > 0) params.set('beforeId', String(beforeId))
  const data = await postJsonToWorkerSafeGet<{ messages: PersonalMessage[] }>(
    `/personal/history?${params.toString()}`,
  )
  if (!data) return { ok: false, messages: [], error: 'Сессия недоступна' }
  return { ok: true, messages: data.messages ?? [] }
}

/** Отправка текста (+опц. реплай). Живая отправка через worker. */
export async function personalSendTextAction(
  channelId: string,
  peer: string,
  text: string,
  replyToMsgId?: number,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  const body = text.trim()
  if (!body) return { ok: false, message: 'Пустое сообщение.' }
  const data = await postJsonToWorker<{ sent?: boolean; error?: string }>(
    '/personal/send',
    {
      channelId,
      peer,
      text: body,
      ...(replyToMsgId ? { replyToMsgId } : {}),
    },
  )
  if (!data?.sent) {
    return { ok: false, message: data?.error || 'Не удалось отправить.' }
  }
  return { ok: true, message: 'Отправлено' }
}

/**
 * Отправка фото/файла (base64 из композера, лимит 15 МБ — покрывает фото
 * и документы; больше гонять через server action непрактично).
 */
export async function personalSendFileAction(
  channelId: string,
  peer: string,
  file: {
    dataB64: string
    name: string
    mime: string | null
    asPhoto: boolean
    caption?: string
    replyToMsgId?: number
  },
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  if (!file.dataB64) return { ok: false, message: 'Пустой файл.' }
  // base64 ≈ 4/3 исходника: 20 МБ строки ≈ 15 МБ файла.
  if (file.dataB64.length > 20 * 1024 * 1024) {
    return { ok: false, message: 'Файл больше 15 МБ — отправьте с телефона.' }
  }
  const data = await postJsonToWorker<{ sent?: boolean; error?: string }>(
    '/personal/send-file',
    {
      channelId,
      peer,
      data: file.dataB64,
      name: file.name,
      mime: file.mime,
      asPhoto: file.asPhoto,
      ...(file.caption ? { caption: file.caption } : {}),
      ...(file.replyToMsgId ? { replyToMsgId: file.replyToMsgId } : {}),
    },
  )
  if (!data?.sent) {
    return { ok: false, message: data?.error || 'Не удалось отправить файл.' }
  }
  return { ok: true, message: 'Отправлено' }
}

/** Голосовое сообщение (ogg/opus из браузерного рекордера). */
export async function personalSendVoiceAction(
  channelId: string,
  peer: string,
  audioB64: string,
  durationSec: number,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  if (!audioB64) return { ok: false, message: 'Пустая запись.' }
  if (audioB64.length > 8 * 1024 * 1024) {
    return { ok: false, message: 'Запись слишком длинная.' }
  }
  const data = await postJsonToWorker<{ sent?: boolean; error?: string }>(
    '/personal/send-voice',
    { channelId, peer, audio: audioB64, durationSec },
  )
  if (!data?.sent) {
    return { ok: false, message: data?.error || 'Не удалось отправить голосовое.' }
  }
  return { ok: true, message: 'Отправлено' }
}

/** Редактирование своего текстового сообщения. */
export async function personalEditMessageAction(
  channelId: string,
  peer: string,
  messageId: number,
  text: string,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  const body = text.trim()
  if (!body) return { ok: false, message: 'Пустое сообщение.' }
  const data = await postJsonToWorker<{ edited?: boolean; error?: string }>(
    '/personal/edit',
    { channelId, peer, messageId, text: body },
  )
  if (!data?.edited) {
    return { ok: false, message: data?.error || 'Не удалось изменить.' }
  }
  return { ok: true, message: 'Изменено' }
}

/** Удаление сообщения (у всех участников). */
export async function personalDeleteMessageAction(
  channelId: string,
  peer: string,
  messageId: number,
): Promise<PersonalActionResult> {
  await requireGod()
  await requirePersonalChannel(channelId)
  const data = await postJsonToWorker<{ deleted?: boolean; error?: string }>(
    '/personal/delete',
    { channelId, peer, messageId },
  )
  if (!data?.deleted) {
    return { ok: false, message: data?.error || 'Не удалось удалить.' }
  }
  return { ok: true, message: 'Удалено' }
}

/** Отметить диалог прочитанным (best-effort). */
export async function personalMarkReadAction(
  channelId: string,
  peer: string,
): Promise<void> {
  await requireGod()
  await requirePersonalChannel(channelId)
  await postJsonToWorker('/personal/read', { channelId, peer })
}

/**
 * GET-запрос к worker'у с JSON-ответом (личные read-эндпоинты — GET, но
 * postJsonToWorker шлёт POST; этот хелпер — GET-парный вариант).
 */
async function postJsonToWorkerSafeGet<T>(path: string): Promise<T | null> {
  const { streamFromWorker } = await import('@/lib/worker-client')
  const res = await streamFromWorker(path)
  if (!res || !res.ok) return null
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}
