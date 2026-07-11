import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

const { Client } = pg
const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to run migrations')
}

const directory = resolve(process.cwd(), 'scripts')
const files = (await readdir(directory))
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))

const client = new Client({ connectionString: databaseUrl })
await client.connect()

try {
  await client.query('SELECT pg_advisory_lock($1)', [928374651])
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const applied = new Map(
    (await client.query('SELECT filename, checksum FROM schema_migrations')).rows
      .map((row) => [row.filename, row.checksum]),
  )

  for (const filename of files) {
    const sql = await readFile(resolve(directory, filename), 'utf8')
    const checksum = createHash('sha256').update(sql).digest('hex')
    const previous = applied.get(filename)
    if (previous) {
      if (previous !== checksum) {
        throw new Error(`Applied migration was modified: ${filename}`)
      }
      continue
    }

    process.stdout.write(`Applying ${filename} ... `)
    await client.query('BEGIN')
    try {
      await client.query(sql)
      await client.query(
        'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
        [filename, checksum],
      )
      await client.query('COMMIT')
      console.log('done')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    }
  }
} finally {
  await client.query('SELECT pg_advisory_unlock($1)', [928374651]).catch(() => {})
  await client.end()
}
