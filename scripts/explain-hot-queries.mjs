/**
 * Diagnostic: run EXPLAIN ANALYZE on the hottest read paths and print whether
 * each plan uses an Index Scan or falls back to a Seq Scan. Read-only (every
 * query is wrapped so nothing is mutated).
 *
 * Usage on the VPS (DATABASE_URL must be set):
 *   node --env-file-if-exists=.env scripts/explain-hot-queries.mjs
 *   # or: node scripts/explain-hot-queries.mjs
 *
 * Run it AFTER applying migration 067 (first_message_at) so the analytics
 * windows are expected to hit idx_conversations_first_message_at.
 */
import pg from 'pg'

const { Client } = pg

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run EXPLAIN diagnostics')
}

// Each entry: a label + a representative query from the app's hot paths.
const QUERIES = [
  {
    label: 'inbox: list conversations (newest activity first)',
    sql: `SELECT id FROM conversations
          WHERE manager_id = $1
          ORDER BY last_message_at DESC
          LIMIT 50`,
    params: ['00000000-0000-0000-0000-000000000000'],
  },
  {
    label: 'analytics: leads in last 7 days (first_message_at window)',
    sql: `SELECT count(*)::int AS n FROM conversations
          WHERE first_message_at >= now() - interval '7 days'`,
    params: [],
  },
  {
    label: 'analytics: leads per day, last 6 days',
    sql: `SELECT date_trunc('day', first_message_at) AS d, count(*)::int AS n
          FROM conversations
          WHERE first_message_at >= now() - interval '6 days'
          GROUP BY 1 ORDER BY 1`,
    params: [],
  },
  {
    label: 'analytics: leads per manager, last 7 days',
    sql: `SELECT manager_id, count(*)::int AS n FROM conversations
          WHERE first_message_at >= now() - interval '7 days'
          GROUP BY manager_id`,
    params: [],
  },
  {
    label: 'inbox: messages for a conversation (newest last)',
    sql: `SELECT id FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at ASC
          LIMIT 100`,
    params: ['00000000-0000-0000-0000-000000000000'],
  },
]

const client = new Client({ connectionString: databaseUrl })
await client.connect()

let anySeqScan = false
try {
  for (const q of QUERIES) {
    const res = await client.query(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${q.sql}`,
      q.params,
    )
    const plan = res.rows.map((r) => r['QUERY PLAN']).join('\n')
    const hasSeqScan = /Seq Scan/.test(plan)
    const usesIndex = /Index (Only )?Scan/.test(plan)
    if (hasSeqScan) anySeqScan = true
    console.log(`\n=== ${q.label} ===`)
    console.log(
      `  verdict: ${
        hasSeqScan ? 'SEQ SCAN (review index)' : usesIndex ? 'index scan OK' : 'no scan / trivial'
      }`,
    )
    console.log(
      plan
        .split('\n')
        .map((l) => '  ' + l)
        .join('\n'),
    )
  }
} finally {
  await client.end()
}

console.log(
  `\nSummary: ${anySeqScan ? 'at least one query used a Seq Scan — investigate above.' : 'all hot queries used index scans.'}`,
)
