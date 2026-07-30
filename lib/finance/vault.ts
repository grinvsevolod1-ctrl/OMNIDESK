/**
 * Finance vault (Хранилище): encrypted credential/secret storage (CRUD).
 */

import {
  query,
} from '../db'
import {
  encrypt,
} from '../crypto'
import {
  type VaultCategory,
  type VaultField,
} from '../finance-types'


/* ------------------------------------------------------------------ */
/* Vault (Хранилище)                                                   */
/* ------------------------------------------------------------------ */

interface VaultInput {
  category: VaultCategory
  title: string
  login: string
  /** Plaintext secret; encrypted here before it touches the DB. '' -> NULL. */
  secret: string
  url: string
  /** Custom fields; serialized + encrypted as one blob. [] -> NULL. */
  fields: VaultField[]
  note: string
  tags: string[]
  favorite: boolean
}

/** Encrypt the main secret; empty -> NULL so we never store an empty envelope. */
function encSecret(secret: string): string | null {
  return secret ? encrypt(secret) : null
}

/** Encrypt the custom fields blob; empty -> NULL. */
function encFields(fields: VaultField[]): string | null {
  if (!fields.length) return null
  const clean = fields
    .map((f) => ({
      label: String(f.label ?? '').trim(),
      value: String(f.value ?? ''),
      secret: Boolean(f.secret),
    }))
    .filter((f) => f.label || f.value)
  return clean.length ? encrypt(JSON.stringify(clean)) : null
}

export async function createFinanceVaultItem(
  resourceId: string,
  input: VaultInput,
): Promise<void> {
  await query(
    `INSERT INTO finance_vault_items
       (resource_id, category, title, login, secret_enc, url, extra_enc,
        note, tags, favorite, sort_order)
     VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
       COALESCE(
         (SELECT MAX(sort_order) + 1 FROM finance_vault_items WHERE resource_id = $1),
         0
       )
     )`,
    [
      resourceId,
      input.category,
      input.title,
      input.login,
      encSecret(input.secret),
      input.url,
      encFields(input.fields),
      input.note,
      input.tags,
      input.favorite,
    ],
  )
}

export async function updateFinanceVaultItem(
  id: string,
  input: VaultInput,
): Promise<void> {
  await query(
    `UPDATE finance_vault_items
        SET category = $2, title = $3, login = $4, secret_enc = $5, url = $6,
            extra_enc = $7, note = $8, tags = $9, favorite = $10,
            updated_at = now()
      WHERE id = $1`,
    [
      id,
      input.category,
      input.title,
      input.login,
      encSecret(input.secret),
      input.url,
      encFields(input.fields),
      input.note,
      input.tags,
      input.favorite,
    ],
  )
}

export async function setFinanceVaultFavorite(
  id: string,
  favorite: boolean,
): Promise<void> {
  await query(
    `UPDATE finance_vault_items SET favorite = $2, updated_at = now() WHERE id = $1`,
    [id, favorite],
  )
}

export async function deleteFinanceVaultItem(id: string): Promise<void> {
  await query(`DELETE FROM finance_vault_items WHERE id = $1`, [id])
}
