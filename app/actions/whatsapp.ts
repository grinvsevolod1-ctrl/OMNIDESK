'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  assignWhatsappNumber,
  createWhatsappNumber,
  deleteWhatsappNumber,
  getWhatsappAppConfig,
  getWhatsappNumberByPhoneId,
  listWhatsappNumbers,
  saveWhatsappAppConfig,
} from '@/lib/data'
import { getPhoneNumber, listWabaPhoneNumbers } from '@/lib/whatsapp-cloud'

export interface WhatsappResult {
  ok: boolean
  message: string
}

/**
 * Admin: verify the saved access token actually works against the Graph API,
 * surfacing scope/expiry problems BEFORE a manager hits them mid-send. Prefers
 * the WABA node (also exercises whatsapp_business_management); falls back to
 * probing a single added number when no WABA id is set.
 */
export async function checkWhatsappTokenAction(): Promise<WhatsappResult> {
  await requireAdmin()

  const cfg = await getWhatsappAppConfig()
  if (!cfg) {
    return { ok: false, message: 'Токен не сохранён. Сначала сохраните настройки.' }
  }

  if (cfg.wabaId) {
    const res = await listWabaPhoneNumbers(cfg.wabaId, cfg.accessToken)
    if (!res.ok) {
      return {
        ok: false,
        message: `Токен недействителен или без прав: ${res.error}`,
      }
    }
    const count = res.data.data?.length ?? 0
    return {
      ok: true,
      message: `Токен действителен. Номеров в WABA: ${count}.`,
    }
  }

  // No WABA id — probe the first added number instead.
  const numbers = await listWhatsappNumbers()
  const first = numbers[0]
  if (!first) {
    return {
      ok: false,
      message:
        'Нечего проверить: укажите WABA ID или добавьте хотя бы один номер.',
    }
  }
  const info = await getPhoneNumber(first.phoneNumberId, cfg.accessToken)
  if (!info.ok) {
    return {
      ok: false,
      message: `Токен недействителен или без прав: ${info.error}`,
    }
  }
  return {
    ok: true,
    message: `Токен действителен (проверено на номере ${info.data.display_phone_number ?? first.phoneNumberId}).`,
  }
}

export interface WhatsappImportResult extends WhatsappResult {
  /** Numbers discovered under the WABA, available to add (excludes existing). */
  candidates?: {
    phoneNumberId: string
    displayPhoneNumber: string
    verifiedName: string
  }[]
}

/**
 * Admin: save the app-level Cloud API credentials (access token, app secret,
 * WABA id). These are shared by every phone number. The verify token + callback
 * URL the admin pastes into Meta are derived from this and shown on the page.
 */
export async function saveWhatsappAppConfigAction(input: {
  accessToken: string
  appSecret: string
  wabaId: string
}): Promise<WhatsappResult> {
  await requireAdmin()

  const accessToken = input.accessToken.trim()
  const appSecret = input.appSecret.trim()
  const wabaId = input.wabaId.trim()

  if (!accessToken) {
    return { ok: false, message: 'Укажите токен доступа.' }
  }

  await saveWhatsappAppConfig({
    accessToken,
    appSecret: appSecret || null,
    wabaId: wabaId || null,
  })

  revalidatePath('/admin/whatsapp')
  return { ok: true, message: 'Настройки приложения WhatsApp сохранены.' }
}

/**
 * Admin: discover phone numbers under the configured WABA. Returns candidates
 * not yet added to the panel so the admin can import them in one click.
 */
export async function importWhatsappNumbersAction(): Promise<WhatsappImportResult> {
  await requireAdmin()

  const cfg = await getWhatsappAppConfig()
  if (!cfg) {
    return { ok: false, message: 'Сначала сохраните настройки приложения.' }
  }
  if (!cfg.wabaId) {
    return {
      ok: false,
      message: 'Укажите WhatsApp Business Account ID в настройках приложения.',
    }
  }

  const res = await listWabaPhoneNumbers(cfg.wabaId, cfg.accessToken)
  if (!res.ok) {
    return {
      ok: false,
      message: `Не удалось получить номера из WABA: ${res.error}`,
    }
  }

  const candidates: NonNullable<WhatsappImportResult['candidates']> = []
  for (const n of res.data.data ?? []) {
    if (!n.id) continue
    const existing = await getWhatsappNumberByPhoneId(n.id)
    if (existing) continue
    candidates.push({
      phoneNumberId: n.id,
      displayPhoneNumber: n.display_phone_number || n.id,
      verifiedName: n.verified_name || '',
    })
  }

  if (candidates.length === 0) {
    return {
      ok: true,
      message: 'Новых номеров не найдено — все номера WABA уже добавлены.',
      candidates: [],
    }
  }
  return {
    ok: true,
    message: `Найдено новых номеров: ${candidates.length}.`,
    candidates,
  }
}

/**
 * Admin: add a single phone number (manual entry or from the import list) and
 * optionally assign it to a manager. Validates the number against the Graph API
 * using the app token before saving.
 */
export async function addWhatsappNumberAction(input: {
  phoneNumberId: string
  name: string
  managerId: string | null
}): Promise<WhatsappResult> {
  await requireAdmin()

  const phoneNumberId = input.phoneNumberId.trim()
  if (!phoneNumberId) {
    return { ok: false, message: 'Укажите Phone Number ID.' }
  }

  const cfg = await getWhatsappAppConfig()
  if (!cfg) {
    return { ok: false, message: 'Сначала сохраните настройки приложения.' }
  }

  const existing = await getWhatsappNumberByPhoneId(phoneNumberId)
  if (existing) {
    return { ok: false, message: 'Этот номер уже добавлен.' }
  }

  // Validate + resolve the display number via Graph API.
  const info = await getPhoneNumber(phoneNumberId, cfg.accessToken)
  if (!info.ok) {
    return {
      ok: false,
      message: `Номер не прошёл проверку: ${info.error}. Убедитесь, что токен имеет доступ к этому номеру.`,
    }
  }

  const displayPhoneNumber =
    info.data.display_phone_number || info.data.verified_name || phoneNumberId
  const name =
    input.name.trim() ||
    info.data.verified_name ||
    info.data.display_phone_number ||
    `WhatsApp ${phoneNumberId}`

  await createWhatsappNumber({
    phoneNumberId,
    displayPhoneNumber,
    name,
    managerId: input.managerId,
  })

  revalidatePath('/admin/whatsapp')
  revalidatePath('/admin/channels')
  return { ok: true, message: `Номер «${displayPhoneNumber}» добавлен.` }
}

/** Admin: (re)assign a number to a manager (null = unassign). */
export async function assignWhatsappNumberAction(
  channelId: string,
  managerId: string | null,
): Promise<WhatsappResult> {
  await requireAdmin()
  await assignWhatsappNumber(channelId, managerId)
  revalidatePath('/admin/whatsapp')
  revalidatePath('/admin/channels')
  return {
    ok: true,
    message: managerId ? 'Номер назначен менеджеру.' : 'Назначение снято.',
  }
}

/** Admin: remove a WhatsApp number. */
export async function deleteWhatsappNumberAction(
  channelId: string,
): Promise<WhatsappResult> {
  await requireAdmin()
  await deleteWhatsappNumber(channelId)
  revalidatePath('/admin/whatsapp')
  revalidatePath('/admin/channels')
  return { ok: true, message: 'Номер удалён.' }
}
