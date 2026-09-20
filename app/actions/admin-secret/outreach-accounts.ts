'use server'

import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { createChannel, enqueueJob } from '@/lib/data'
import { query } from '@/lib/db'
import {
  createAccount,
  deleteAccount,
  getAccount,
  linkAccountChannel,
  listAccounts,
  reassignAccount,
  setAccountProxy,
  setAccountStatus,
  type OutreachAccount,
} from '@/lib/data/outreach-accounts'
import { pickApiKeyForNewAccount } from '@/lib/data/outreach-api-keys'
import {
  personalDeleteAction,
  personalStartAction,
  personalStopAction,
} from './telegram-personal'

/* ===================================================================== */
/*  Исходящие — пул боевых аккаунтов (god-панель).                         */
/*  Подключение переиспользует проверенный конвейер личных каналов:        */
/*  канал type='telegram_personal' с config.outreach=true, поэтому весь    */
/*  QR/телефон/код/2FA-флоу воркера работает без изменений, а сам аккаунт  */
/*  скрыт из обычной вкладки «Telegram» (фильтр по config.outreach).       */
/* ===================================================================== */

async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

export interface OutreachConnectResult {
  ok: boolean
  message: string
  accountId?: string
  channelId?: string
}

export async function listOutreachAccountsAction(): Promise<OutreachAccount[]> {
  await requireGod()
  return listAccounts()
}

export interface OutreachManagerOption {
  id: string
  name: string
}

/** Активные менеджеры продаж для выпадающего списка назначения. */
export async function listOutreachManagersAction(): Promise<
  OutreachManagerOption[]
> {
  await requireGod()
  const rows = await query<{ id: string; name: string }>(
    `SELECT id, name FROM managers
      WHERE role = 'manager' AND status = 'active'
      ORDER BY name ASC`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name }))
}

/**
 * Создать аккаунт (с автоподбором api-ключа из пула) и запустить подключение.
 * mode='qr' → start_qr, mode='phone' → start (код придёт в приложение).
 * Возвращает channelId — дальше диалог поллит статус через personal*-экшены.
 */
export async function outreachCreateAndConnectAction(input: {
  label: string
  mode: 'qr' | 'phone'
  phone?: string
  proxy?: string
}): Promise<OutreachConnectResult> {
  await requireGod()

  const apiKeyId = await pickApiKeyForNewAccount()
  if (!apiKeyId) {
    return {
      ok: false,
      message:
        'Нет свободных API-ключей. Добавьте ключ на вкладке «API-ключи» или увеличьте лимит.',
    }
  }

  let phone: string | null = null
  if (input.mode === 'phone') {
    const digits = (input.phone ?? '').replace(/[\s\-()]/g, '')
    if (!/^\+?[0-9]{7,15}$/.test(digits)) {
      return { ok: false, message: 'Введите корректный номер, например +14155550132.' }
    }
    phone = digits.startsWith('+') ? digits : `+${digits}`
  }

  const accountId = await createAccount({
    label: input.label,
    phone: phone ?? undefined,
    apiKeyId,
    proxy: input.proxy,
  })

  const channel = await createChannel({
    managerId: null,
    type: 'telegram_personal',
    name: input.label.trim() || 'Аккаунт исходящих',
    detail: input.mode === 'qr' ? 'QR-подключение' : (phone ?? ''),
    status: 'pending',
    sessionStatus: 'starting',
    phone,
    proxyId: null,
    config: { outreach: true, outreachAccountId: accountId },
  })

  await linkAccountChannel(accountId, channel.id)
  await setAccountStatus(accountId, 'connecting')

  if (input.mode === 'qr') {
    await enqueueJob({
      channelId: channel.id,
      managerId: null,
      action: 'start_qr',
      payload: { attemptId: globalThis.crypto.randomUUID() },
    })
  } else {
    await enqueueJob({
      channelId: channel.id,
      managerId: null,
      action: 'start',
      payload: { phone, attemptId: globalThis.crypto.randomUUID() },
    })
  }

  return {
    ok: true,
    message: input.mode === 'qr' ? 'Генерируем QR-код…' : 'Запрашиваем код входа…',
    accountId,
    channelId: channel.id,
  }
}

export async function outreachAssignAction(
  id: string,
  managerId: string | null,
): Promise<OutreachAccount[]> {
  await requireGod()
  await reassignAccount(id, managerId)
  return listAccounts()
}

export async function outreachSetProxyAction(
  id: string,
  proxy: string,
): Promise<OutreachAccount[]> {
  await requireGod()
  await setAccountProxy(id, proxy.trim() || null)
  return listAccounts()
}

export async function outreachStopAction(id: string): Promise<OutreachAccount[]> {
  await requireGod()
  const acc = await getAccount(id)
  if (acc?.channelId) await personalStopAction(acc.channelId)
  await setAccountStatus(id, 'offline')
  return listAccounts()
}

export async function outreachStartAction(id: string): Promise<OutreachAccount[]> {
  await requireGod()
  const acc = await getAccount(id)
  if (acc?.channelId) await personalStartAction(acc.channelId)
  await setAccountStatus(id, 'connecting')
  return listAccounts()
}

export async function outreachDeleteAction(id: string): Promise<OutreachAccount[]> {
  await requireGod()
  const acc = await getAccount(id)
  // Отзываем авторизацию и удаляем связанный канал (logout стирает секреты).
  if (acc?.channelId) {
    try {
      await personalDeleteAction(acc.channelId)
    } catch {
      /* канал мог быть уже удалён — продолжаем удаление аккаунта */
    }
  }
  await deleteAccount(id)
  return listAccounts()
}
