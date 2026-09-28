/**
 * Encrypts pre-existing plaintext god-panel values in place.
 *
 * Runs on every panel start (instrumentation-node.ts) so no manual step is
 * needed on the server after an auto-deploy. Idempotent: only rows whose value
 * does not yet carry the `g1.` envelope prefix are touched, and each UPDATE is
 * guarded by the old value so a concurrent write from the app is never
 * overwritten with a stale ciphertext.
 */
import { query } from './db'
import { godSeal } from './god-crypto'
import { GOD_ENVELOPE_PREFIX } from './god-envelope'

interface Target {
  table: string
  column: string
  where?: string
}

export const GOD_ENCRYPTED_COLUMNS: readonly Target[] = [
  { table: 'god_sites', column: 'api_key_plain' },
  { table: 'app_settings', column: 'value', where: `key = 'gmt_api_key'` },
  { table: 'broadcast_campaigns', column: 'context' },
  { table: 'broadcast_campaigns', column: 'base_text' },
  { table: 'broadcast_campaigns', column: 'captcha_reply' },
  { table: 'broadcast_campaigns', column: 'last_error' },
  { table: 'broadcast_targets', column: 'raw_input' },
  { table: 'broadcast_targets', column: 'resolved_peer_id' },
  { table: 'broadcast_targets', column: 'resolved_title' },
  { table: 'broadcast_targets', column: 'draft_text' },
  { table: 'broadcast_targets', column: 'error' },
]

const BATCH = 200

async function tableExists(table: string): Promise<boolean> {
  const rows = await query<{ ok: boolean }>(
    `SELECT to_regclass($1) IS NOT NULL AS ok`,
    [`public.${table}`],
  )
  return rows[0]?.ok === true
}

async function encryptColumn({ table, column, where }: Target): Promise<number> {
  const extra = where ? `AND ${where}` : ''
  let total = 0
  for (;;) {
    const rows = await query<{ ctid: string; v: string }>(
      `SELECT ctid::text AS ctid, ${column}::text AS v FROM ${table}
       WHERE ${column} IS NOT NULL AND ${column}::text <> ''
         AND left(${column}::text, ${GOD_ENVELOPE_PREFIX.length}) <> $1 ${extra}
       LIMIT ${BATCH}`,
      [GOD_ENVELOPE_PREFIX],
    )
    if (rows.length === 0) return total
    let changed = 0
    for (const row of rows) {
      const res = await query<{ n: number }>(
        `UPDATE ${table} SET ${column} = $1
         WHERE ctid = $2::tid AND ${column}::text = $3
         RETURNING 1 AS n`,
        [godSeal(row.v), row.ctid, row.v],
      )
      changed += res.length
    }
    total += changed
    if (changed === 0) return total
  }
}

export async function backfillGodEncryption(): Promise<Record<string, number>> {
  const result: Record<string, number> = {}
  const existence = new Map<string, boolean>()
  for (const target of GOD_ENCRYPTED_COLUMNS) {
    if (!existence.has(target.table)) {
      existence.set(target.table, await tableExists(target.table))
    }
    if (!existence.get(target.table)) continue
    const n = await encryptColumn(target)
    if (n > 0) result[`${target.table}.${target.column}`] = n
  }
  return result
}
