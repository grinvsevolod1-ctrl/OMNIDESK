'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { getOffhoursMessengers, saveOffhoursMessengers } from '@/lib/data'
import { isValidTelegramLink, whatsappLinkFromPhone } from '@/lib/offhours'

export interface OffhoursResult {
  ok: boolean
  message: string
}

/**
 * Admin: save the off-hours messenger lists shown to website visitors outside
 * working hours. Telegram links and WhatsApp phone numbers are validated and
 * stored as ordered lists; the order is the round-robin distribution order.
 */
export async function saveOffhoursMessengersAction(input: {
  telegramLinks: string[]
  whatsappPhones: string[]
}): Promise<OffhoursResult> {
  await requireAdmin()

  const telegramLinks = (input.telegramLinks ?? [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)
  const whatsappPhones = (input.whatsappPhones ?? [])
    .map((v) => String(v ?? '').trim())
    .filter(Boolean)

  for (const link of telegramLinks) {
    if (!isValidTelegramLink(link)) {
      return {
        ok: false,
        message: `Некорректная Telegram-ссылка: ${link}. Используйте формат https://t.me/...`,
      }
    }
  }
  for (const phone of whatsappPhones) {
    if (!whatsappLinkFromPhone(phone)) {
      return {
        ok: false,
        message: `Некорректный номер WhatsApp: ${phone}. Укажите номер телефона.`,
      }
    }
  }

  await saveOffhoursMessengers({ telegramLinks, whatsappPhones })
  revalidatePath('/admin/livechat')
  return { ok: true, message: 'Настройки мессенджеров сохранены.' }
}

/** Read current settings (used to hydrate the admin form). */
export async function getOffhoursMessengersAction() {
  await requireAdmin()
  return getOffhoursMessengers()
}
