import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

const { Client } = pg

const command = process.argv[2] ?? 'up'
if (!['up', 'status'].includes(command)) {
  throw new Error(`Unknown command "${command}". Use "up" or "status".`)
}

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

// Load the checksum of every file up front so both commands share the logic.
async function loadFiles() {
  const entries = []
  for (const filename of files) {
    const sql = await readFile(resolve(directory, filename), 'utf8')
    entries.push({
      filename,
      sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
    })
  }
  return entries
}

try {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `)

  const entries = await loadFiles()
  const applied = new Map(
    (await client.query('SELECT filename, checksum FROM schema_migrations')).rows
      .map((row) => [row.filename, row.checksum]),
  )

  if (command === 'status') {
    let pending = 0
    for (const { filename, checksum } of entries) {
      const previous = applied.get(filename)
      if (!previous) {
        pending += 1
        console.log(`pending   ${filename}`)
      } else if (previous !== checksum) {
        console.log(`MODIFIED  ${filename}`)
      } else {
        console.log(`applied   ${filename}`)
      }
    }
    console.log(`\n${entries.length} migration(s), ${pending} pending.`)
  } else {
    // Serialize concurrent runners so two deploys never apply the same file.
    await client.query('SELECT pg_advisory_lock($1)', [928374651])
    try {
      for (const { filename, sql, checksum } of entries) {
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
    }
  }
} finally {
  await client.end()
}
