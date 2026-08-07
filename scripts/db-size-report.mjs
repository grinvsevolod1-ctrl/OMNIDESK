// Отчёт о размере БД перед решением о партиционировании messages.
// Запуск на VPS:  pnpm db:size
// Ничего не меняет — только читает статистику. Безопасен в любое время.

import pg from 'pg'

const { Client } = pg

const url =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.POSTGRES_PRISMA_URL

if (!url) {
  console.error('DATABASE_URL is not set')
  process.exit(1)
}

const client = new Client({ connectionString: url })
await client.connect()

try {
  const fmt = (n) => Number(n).toLocaleString('ru-RU')

  const { rows: top } = await client.query(`
    SELECT relname AS table,
           to_char(n_live_tup, 'FM999G999G999') AS rows_approx,
           pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
           pg_size_pretty(pg_relation_size(relid))       AS table_size,
           pg_size_pretty(pg_indexes_size(relid))        AS index_size
      FROM pg_stat_user_tables
     ORDER BY pg_total_relation_size(relid) DESC
     LIMIT 12
  `)
  console.log('\n=== Топ-12 таблиц по размеру ===')
  console.table(top)

  const { rows: msg } = await client.query(`
    SELECT count(*)::bigint AS exact_rows,
           min(created_at)  AS oldest,
           max(created_at)  AS newest
      FROM messages
  `)
  console.log('\n=== messages: точный размер ===')
  console.log('строк:  ', fmt(msg[0].exact_rows))
  console.log('старейшее сообщение:', msg[0].oldest)
  console.log('новейшее сообщение: ', msg[0].newest)

  const { rows: byMonth } = await client.query(`
    SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') AS month,
           count(*)::bigint AS rows
      FROM messages
     GROUP BY 1 ORDER BY 1 DESC LIMIT 12
  `)
  console.log('\n=== messages по месяцам (последние 12) ===')
  console.table(byMonth)

  const { rows: blobs } = await client.query(`
    SELECT count(*)::bigint AS blobs,
           pg_size_pretty(coalesce(sum(byte_size), 0)) AS bytes
      FROM media_blobs
  `)
  console.log('\n=== media_blobs ===')
  console.log('блобов:', fmt(blobs[0].blobs), ' объём:', blobs[0].bytes)

  const { rows: db } = await client.query(
    `SELECT pg_size_pretty(pg_database_size(current_database())) AS size`,
  )
  console.log('\n=== Вся БД ===')
  console.log('размер:', db[0].size)

  const n = Number(msg[0].exact_rows)
  console.log('\n=== Вердикт ===')
  if (n < 500_000) {
    console.log(
      `messages: ${fmt(n)} строк — партиционирование НЕ нужно, индексы справляются с запасом.`,
    )
  } else if (n < 2_000_000) {
    console.log(
      `messages: ${fmt(n)} строк — пограничная зона. Если чаты открываются быстро, не трогать.`,
    )
  } else {
    console.log(
      `messages: ${fmt(n)} строк — партиционирование имеет смысл, планируйте окно работ.`,
    )
  }
} finally {
  await client.end()
}
