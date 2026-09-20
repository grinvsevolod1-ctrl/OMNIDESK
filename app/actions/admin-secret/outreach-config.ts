'use server'

import { notFound } from 'next/navigation'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import {
  createApiKey,
  deleteApiKey,
  listApiKeys,
  setApiKeyMaxAccounts,
  setApiKeyStatus,
  type OutreachApiKey,
} from '@/lib/data/outreach-api-keys'
import {
  clearBotToken,
  getBotConfig,
  getWarmupConfig,
  setBotToken,
  setWarmupConfig,
  type OutreachBotConfig,
  type WarmupConfig,
} from '@/lib/data/outreach-config'

/* ===================================================================== */
/*  Исходящие — конфиг (god-панель): пул API-ключей, бот лидов, прогрев.   */
/*  Гейт как у остальных admin-secret: admin-сессия И god-разблокировка.   */
/* ===================================================================== */

async function requireGod(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) notFound()
}

/* ------------------------------ API-ключи -------------------------------- */

export async function listApiKeysAction(): Promise<OutreachApiKey[]> {
  await requireGod()
  return listApiKeys()
}

export async function createApiKeyAction(input: {
  label: string
  apiId: number
  apiHash: string
  maxAccounts?: number
}): Promise<OutreachApiKey[]> {
  await requireGod()
  if (!Number.isFinite(input.apiId) || input.apiId <= 0) {
    throw new Error('api_id должен быть положительным числом')
  }
  if (!input.apiHash.trim()) throw new Error('Укажите api_hash')
  await createApiKey(input)
  return listApiKeys()
}

export async function setApiKeyStatusAction(
  id: string,
  status: 'active' | 'disabled',
): Promise<OutreachApiKey[]> {
  await requireGod()
  await setApiKeyStatus(id, status)
  return listApiKeys()
}

export async function setApiKeyMaxAccountsAction(
  id: string,
  maxAccounts: number,
): Promise<OutreachApiKey[]> {
  await requireGod()
  await setApiKeyMaxAccounts(id, maxAccounts)
  return listApiKeys()
}

export async function deleteApiKeyAction(
  id: string,
): Promise<OutreachApiKey[]> {
  await requireGod()
  await deleteApiKey(id)
  return listApiKeys()
}

/* ------------------------------- Бот лидов ------------------------------- */

export async function getBotConfigAction(): Promise<OutreachBotConfig> {
  await requireGod()
  return getBotConfig()
}

export async function setBotTokenAction(input: {
  token: string
  username?: string
}): Promise<OutreachBotConfig> {
  await requireGod()
  await setBotToken(input.token, input.username)
  return getBotConfig()
}

export async function clearBotTokenAction(): Promise<OutreachBotConfig> {
  await requireGod()
  await clearBotToken()
  return getBotConfig()
}

/* -------------------------------- Прогрев -------------------------------- */

export async function getWarmupConfigAction(): Promise<WarmupConfig> {
  await requireGod()
  return getWarmupConfig()
}

export async function setWarmupConfigAction(
  patch: Partial<WarmupConfig>,
): Promise<WarmupConfig> {
  await requireGod()
  return setWarmupConfig(patch)
}
