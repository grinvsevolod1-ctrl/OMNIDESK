#!/usr/bin/env node
/**
 * Seed realistic TEST data for local/dev auditing.
 *
 * Creates employees of every role (manager / curator / head / buyer), teams,
 * traffic sources, channels, conversations with messages, and lead cards across
 * all lifecycle statuses. Safe to re-run: it first removes anything it created
 * previously (scoped to the '@omnidesk.test' employee namespace) and re-inserts.
 *
 * All employee passwords: test12345
 *
 * Usage:
 *   node --env-file-if-exists=.env.local scripts/seed-test-data.mjs
 */
import pg from 'pg'
import bcrypt from 'bcryptjs'

const { Pool } = pg

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('[seed-test-data] DATABASE_URL is not set')
  process.exit(1)
}

const pool = new Pool({ connectionString: DATABASE_URL })

const TEST_DOMAIN = '@omnidesk.test'
const PASSWORD = 'test12345'

function pick(arr, i) {
  return arr[i % arr.length]
}

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 12)
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // ---- Clean up previous test data (scoped, FK-safe order) -------------
    const prev = await client.query(
      `SELECT id FROM managers WHERE email LIKE $1`,
      [`%${TEST_DOMAIN}`],
    )
    const prevIds = prev.rows.map((r) => r.id)
    if (prevIds.length) {
      // conversations tied to test channels/managers cascade to messages
      await client.query(
        `DELETE FROM messages WHERE conversation_id IN (
           SELECT id FROM conversations WHERE manager_id = ANY($1)
             OR channel_id IN (SELECT id FROM channels WHERE manager_id = ANY($1)))`,
        [prevIds],
      )
      await client.query(
        `DELETE FROM lead_cards WHERE manager_id = ANY($1) OR curator_id = ANY($1)`,
        [prevIds],
      )
      await client.query(
        `DELETE FROM conversations WHERE manager_id = ANY($1)
           OR channel_id IN (SELECT id FROM channels WHERE manager_id = ANY($1))`,
        [prevIds],
      )
      await client.query(`DELETE FROM channels WHERE manager_id = ANY($1)`, [
        prevIds,
      ])
      await client.query(
        `UPDATE managers SET team_id = NULL, traffic_source_id = NULL WHERE id = ANY($1)`,
        [prevIds],
      )
      await client.query(
        `DELETE FROM teams WHERE head_id = ANY($1)`,
        [prevIds],
      )
      await client.query(
        `DELETE FROM traffic_sources WHERE buyer_id = ANY($1)`,
        [prevIds],
      )
      await client.query(`DELETE FROM managers WHERE id = ANY($1)`, [prevIds])
    }

    // ---- Employees --------------------------------------------------------
    async function addManager({ name, email, username, role, city = null }) {
      const res = await client.query(
        `INSERT INTO managers (name, email, username, password_hash, role, city, status)
         VALUES ($1,$2,$3,$4,$5,$6,'active') RETURNING id`,
        [name, email, username, passwordHash, role, city],
      )
      return res.rows[0].id
    }

    const head = await addManager({
      name: 'Руководитель Головин',
      email: `head${TEST_DOMAIN}`,
      username: 'head',
      role: 'head',
    })
    const buyer = await addManager({
      name: 'Байер Баринов',
      email: `buyer${TEST_DOMAIN}`,
      username: 'buyer',
      role: 'buyer',
    })
    const curator1 = await addManager({
      name: 'Куратор Кузнецова',
      email: `curator1${TEST_DOMAIN}`,
      username: 'curator1',
      role: 'curator',
      city: 'Москва',
    })
    const curator2 = await addManager({
      name: 'Куратор Каримов',
      email: `curator2${TEST_DOMAIN}`,
      username: 'curator2',
      role: 'curator',
      city: 'Санкт-Петербург',
    })
    const managers = []
    for (let i = 1; i <= 3; i++) {
      managers.push(
        await addManager({
          name: `Менеджер №${i}`,
          email: `manager${i}${TEST_DOMAIN}`,
          username: `manager${i}`,
          role: 'manager',
        }),
      )
    }

    // ---- Team (head leads managers 1 & 2) --------------------------------
    const team = (
      await client.query(
        `INSERT INTO teams (name, head_id) VALUES ($1,$2) RETURNING id`,
        ['Команда Альфа', head],
      )
    ).rows[0].id
    await client.query(
      `UPDATE managers SET team_id = $1 WHERE id = ANY($2)`,
      [team, [managers[0], managers[1]]],
    )
    // head can edit
    await client.query(`UPDATE managers SET head_can_edit = true WHERE id = $1`, [
      head,
    ])

    // ---- Traffic sources (buyer owns one) --------------------------------
    const src1 = (
      await client.query(
        `INSERT INTO traffic_sources (id, name, buyer_id, notes)
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
        ['Telegram Ads — гео РФ', buyer, 'Основной источник'],
      )
    ).rows[0].id
    const src2 = (
      await client.query(
        `INSERT INTO traffic_sources (id, name, buyer_id, notes)
         VALUES (gen_random_uuid(), $1, $2, $3) RETURNING id`,
        ['VK таргет', buyer, 'Вторичный источник'],
      )
    ).rows[0].id
    await client.query(
      `UPDATE managers SET traffic_source_id = $1 WHERE id = ANY($2)`,
      [src1, [managers[0], managers[1]]],
    )
    await client.query(
      `UPDATE managers SET traffic_source_id = $1 WHERE id = $2`,
      [src2, managers[2]],
    )

    // ---- Channels (one per manager, varied types) ------------------------
    const chTypes = ['telegram', 'livechat', 'whatsapp']
    const channels = []
    for (let i = 0; i < managers.length; i++) {
      const type = pick(chTypes, i)
      const ch = (
        await client.query(
          `INSERT INTO channels (manager_id, type, name, status, session_status, connected_at)
           VALUES ($1,$2,$3,'connected','online',now()) RETURNING id`,
          [managers[i], type, `${type} канал ${i + 1}`],
        )
      ).rows[0].id
      channels.push({ id: ch, type, manager: managers[i], src: i < 2 ? src1 : src2 })
    }

    // ---- Conversations + messages + lead cards ---------------------------
    const statuses = ['unsubscribed', 'handoff', 'liquid', 'not_liquid', 'transferred']
    // lead_cards use a separate HR-style vocabulary (curator lifecycle)
    const leadStatuses = ['new', 'training', 'working', 'refused', 'no_contact', 'left']
    const cities = ['Москва', 'Санкт-Петербург', 'Казань', 'Екатеринбург']
    const vacancies = ['Курьер', 'Упаковщик', 'Оператор', 'Водитель']
    let convCount = 0
    let leadCount = 0

    for (let i = 0; i < 24; i++) {
      const ch = pick(channels, i)
      const status = pick(statuses, i)
      const city = pick(cities, i)
      const transferred = status === 'transferred'
      const aiLed = status === 'unsubscribed' || status === 'liquid'
      const curatorId = transferred ? (i % 2 === 0 ? curator1 : curator2) : null

      const conv = (
        await client.query(
          `INSERT INTO conversations
             (channel_id, manager_id, channel_type, contact_name, contact_handle,
              contact_username, last_message, last_message_at, unread, status,
              status_updated_at, curator_id, transferred_to_curator_at,
              ai_enrolled, first_message_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' hours')::interval, $9, $10,
              now(), $11, $12, true, now() - interval '2 days', now() - interval '2 days')
           RETURNING id`,
          [
            ch.id,
            ch.manager,
            ch.type,
            `Клиент ${i + 1}`,
            `+7900000${String(1000 + i)}`,
            `client_${i + 1}`,
            'Здравствуйте, интересует вакансия',
            String(i),
            i % 3 === 0 ? 2 : 0,
            status,
            curatorId,
            transferred ? new Date() : null,
          ],
        )
      ).rows[0].id
      convCount++

      // messages: an inbound + AI/manager outbound thread
      await client.query(
        `INSERT INTO messages (conversation_id, direction, body, author, status, created_at)
         VALUES
           ($1,'in',$2,'client',null, now() - interval '2 days'),
           ($1,'out',$3,$4,'read', now() - interval '2 days' + interval '3 minutes'),
           ($1,'in',$5,'client',null, now() - interval '1 day'),
           ($1,'out',$6,$4,'delivered', now() - interval '1 day' + interval '2 minutes')`,
        [
          conv,
          'Здравствуйте, интересует вакансия',
          'Здравствуйте! Расскажите, из какого вы города?',
          aiLed ? 'ai' : 'manager',
          `Я из города ${city}`,
          'Отлично, подберём вам подходящий вариант.',
        ],
      )

      // lead card for non-unsubscribed leads
      if (status !== 'unsubscribed') {
        const leadStatus = pick(leadStatuses, i)
        await client.query(
          `INSERT INTO lead_cards
             (conversation_id, manager_id, curator_id, full_name, phone,
              telegram_username, city, vacancy, status, traffic_source_id, team_id,
              transferred_at, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now() - interval '1 day', now())`,
          [
            conv,
            ch.manager,
            curatorId,
            `Клиент ${i + 1}`,
            `+7900000${String(1000 + i)}`,
            `client_${i + 1}`,
            city,
            pick(vacancies, i),
            leadStatus,
            ch.src,
            [managers[0], managers[1]].includes(ch.manager) ? team : null,
            transferred ? new Date() : null,
          ],
        )
        leadCount++
      }
    }

    await client.query('COMMIT')

    console.log('[seed-test-data] done:')
    console.log(`  employees: 1 head, 1 buyer, 2 curators, ${managers.length} managers`)
    console.log(`  teams: 1, traffic sources: 2, channels: ${channels.length}`)
    console.log(`  conversations: ${convCount}, lead cards: ${leadCount}`)
    console.log('')
    console.log('  Login (password for all): ' + PASSWORD)
    console.log('    head      → head' + TEST_DOMAIN)
    console.log('    buyer     → buyer' + TEST_DOMAIN)
    console.log('    curator1  → curator1' + TEST_DOMAIN + ' (Москва)')
    console.log('    curator2  → curator2' + TEST_DOMAIN + ' (СПб)')
    console.log('    manager1  → manager1' + TEST_DOMAIN)
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((err) => {
  console.error('[seed-test-data] failed:', err)
  process.exit(1)
})
