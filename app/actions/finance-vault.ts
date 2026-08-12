'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  createFinanceVaultItem,
  deleteFinanceVaultItem,
  setFinanceVaultFavorite,
  updateFinanceVaultItem,
  type VaultField,
} from '@/lib/finance'
import {
  MAX_NAME,
  MAX_NOTES,
  MAX_REF,
  MAX_TITLE,
  parseTags,
  parseVaultCategory,
  parseVaultFields,
  type FinanceResult,
} from './finance-shared'

/* -------------------------------------------------------------- */
/* Vault (Хранилище)                                              */
/* -------------------------------------------------------------- */

function readVaultForm(formData: FormData) {
  return {
    category: parseVaultCategory(String(formData.get('category') ?? '')),
    title: String(formData.get('title') ?? '').trim().slice(0, MAX_TITLE),
    login: String(formData.get('login') ?? '').trim().slice(0, MAX_REF),
    secret: String(formData.get('secret') ?? '').slice(0, MAX_NOTES),
    url: String(formData.get('url') ?? '').trim().slice(0, MAX_NOTES),
    fields: parseVaultFields(String(formData.get('fields') ?? '')),
    note: String(formData.get('note') ?? '').trim().slice(0, MAX_NOTES),
    tags: parseTags(String(formData.get('tags') ?? '')),
    favorite: String(formData.get('favorite') ?? '') === 'true',
  }
}

export async function createVaultItemAction(
  resourceId: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!resourceId) return { ok: false, message: 'Ресурс не найден.' }
  const input = readVaultForm(formData)
  if (!input.title) return { ok: false, message: 'Укажите название записи.' }
  try {
    await createFinanceVaultItem(resourceId, input)
  } catch {
    return {
      ok: false,
      message:
        'Не удалось зашифровать секрет. Задайте ENCRYPTION_KEY (openssl rand -hex 32).',
    }
  }
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись добавлена в хранилище.' }
}

export async function updateVaultItemAction(
  id: string,
  formData: FormData,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }
  const input = readVaultForm(formData)
  if (!input.title) return { ok: false, message: 'Укажите название записи.' }
  try {
    await updateFinanceVaultItem(id, input)
  } catch {
    return {
      ok: false,
      message:
        'Не удалось зашифровать секрет. Задайте ENCRYPTION_KEY (openssl rand -hex 32).',
    }
  }
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись обновлена.' }
}

export async function toggleVaultFavoriteAction(
  id: string,
  favorite: boolean,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }
  await setFinanceVaultFavorite(id, favorite)
  revalidatePath('/admin/finance')
  return { ok: true, message: favorite ? 'Закреплено.' : 'Откреплено.' }
}

export async function deleteVaultItemAction(
  id: string,
): Promise<FinanceResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Запись не найдена.' }
  await deleteFinanceVaultItem(id)
  revalidatePath('/admin/finance')
  return { ok: true, message: 'Запись удалена из хранилища.' }
}

interface VaultImportRow {
  category?: string
  title?: string
  login?: string
  secret?: string
  url?: string
  note?: string
  tags?: string[]
  favorite?: boolean
  fields?: VaultField[]
}

export async function importVaultItemsAction(
  resourceId: string,
  rows: VaultImportRow[],
): Promise<FinanceResult> {
  await requireAdmin()
  if (!resourceId) return { ok: false, message: 'Ресурс не найден.' }
  if (!Array.isArray(rows) || rows.length === 0) {
    return { ok: false, message: 'Нет записей для импорта.' }
  }
  if (rows.length > 500) {
    return { ok: false, message: 'За один раз можно импортировать до 500 записей.' }
  }

  let imported = 0
  try {
    for (const raw of rows) {
      const title = String(raw.title ?? '').trim().slice(0, MAX_TITLE)
      if (!title) continue
      const fields: VaultField[] = Array.isArray(raw.fields)
        ? raw.fields
            .filter((f) => f && typeof f === 'object')
            .map((f) => ({
              label: String(f.label ?? '').trim().slice(0, MAX_NAME),
              value: String(f.value ?? '').slice(0, MAX_NOTES),
              secret: Boolean(f.secret),
            }))
            .filter((f) => f.label || f.value)
            .slice(0, 40)
        : []
      await createFinanceVaultItem(resourceId, {
        category: parseVaultCategory(String(raw.category ?? '')),
        title,
        login: String(raw.login ?? '').trim().slice(0, MAX_REF),
        secret: String(raw.secret ?? '').slice(0, MAX_NOTES),
        url: String(raw.url ?? '').trim().slice(0, MAX_NOTES),
        fields,
        note: String(raw.note ?? '').trim().slice(0, MAX_NOTES),
        tags: Array.isArray(raw.tags)
          ? raw.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean).slice(0, 20)
          : [],
        favorite: raw.favorite === true,
      })
      imported += 1
    }
  } catch {
    return {
      ok: false,
      message:
        'Импорт прерван. Проверьте, что задан ENCRYPTION_KEY для шифрования секретов.',
    }
  }

  revalidatePath('/admin/finance')
  return {
    ok: imported > 0,
    message: imported > 0 ? `Импортировано записей: ${imported}.` : 'Подходящих записей не найдено.',
  }
}
