/**
 * One-time, idempotent seed of the managed dictionaries into app_settings.
 *
 * Writes the FULL snapshot of every value that used to be hardcoded (lead
 * status names/descriptions, channel type labels, account/proxy/hosting status
 * captions, OS-shell quick commands and greeting) under the `dictionaries`
 * key. Uses ON CONFLICT DO NOTHING so an existing row — i.e. any admin edits
 * made through the copilot — is NEVER overwritten. Safe to run on every
 * deploy; deploy.sh calls it right after migrations.
 *
 * Usage: node --env-file=.env scripts/seed-dictionaries.mjs
 *
 * NOTE: the snapshot below intentionally duplicates DEFAULT_DICTIONARIES from
 * lib/dictionaries.ts (an .mjs script cannot import project TS). If defaults
 * evolve, this seed does NOT need updating: resolveDictionaries() merges new
 * defaults over the stored value at read time, so missing sections simply
 * fall back to code defaults.
 */
import pg from 'pg'

const { Client } = pg

const databaseUrl = process.env.DATABASE_URL
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to seed dictionaries')
}

const SNAPSHOT = {
  leadStatuses: {
    unsubscribed: { label: 'Отписок', description: 'Всего написавших людей' },
    handoff: {
      label: 'Передан человеку',
      description: 'ИИ передал диалог менеджеру или менеджер вступил сам',
    },
    liquid: {
      label: 'Ликвид',
      description: 'Подходящая аудитория по нужным параметрам',
    },
    not_liquid: { label: 'Не ликвид', description: 'Не подходящая аудитория' },
    transferred: {
      label: 'Передан',
      description: 'Подошёл, прошёл и передан дальше',
    },
  },
  notLiquidReasons: {
    geo: { label: 'Гео', description: 'Не наше гео' },
    under18: { label: '-18', description: 'Младше 18 лет' },
    na: { label: 'NA', description: 'Не отвечает / не актуально' },
    trash: { label: 'TRASH', description: 'Мусорный контакт' },
  },
  channelTypes: {
    telegram: 'Telegram',
    whatsapp: 'WhatsApp',
    vk: 'VK',
    max: 'MAX',
    livechat: 'Онлайн-чат',
  },
  accountStatuses: {
    connected: 'Подключён',
    pending: 'Подключается',
    error: 'Ошибка',
    disconnected: 'Отключён',
  },
  proxyStatuses: {
    ok: 'Работает',
    error: 'Не работает',
    unknown: 'Не проверен',
  },
  serverStatuses: {
    online: 'В сети',
    offline: 'Не в сети',
    unknown: 'Не проверен',
  },
  appStatuses: {
    stopped: 'Остановлено',
    building: 'Сборка',
    running: 'Работает',
    error: 'Ошибка',
  },
  deploymentStatuses: {
    queued: 'В очереди',
    cloning: 'Клонирование',
    building: 'Сборка',
    running: 'Запуск',
    success: 'Успешно',
    failed: 'Ошибка',
  },
  shellQuickCommands: [
    { label: 'Сводка за сегодня', prompt: 'Покажи сводку за сегодня' },
    { label: 'Статусы аккаунтов', prompt: 'Покажи статусы всех аккаунтов' },
    { label: 'Менеджеры', prompt: 'Покажи список менеджеров' },
    { label: 'Финансы за месяц', prompt: 'Покажи финансовую сводку за месяц' },
    { label: 'Каналы и прокси', prompt: 'Покажи каналы и прокси' },
    { label: 'Контакты', prompt: 'Покажи последние контакты' },
  ],
  shellGreeting:
    'Я управляю всей админкой: метрики, менеджеры, аккаунты, финансы, каналы, прокси, контакты и справочники. Спросите или скомандуйте — опасные действия выполню только после вашего подтверждения.',
}

const client = new Client({ connectionString: databaseUrl })
await client.connect()

try {
  const res = await client.query(
    `INSERT INTO app_settings (key, value, updated_at)
       VALUES ('dictionaries', $1::jsonb, now())
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [JSON.stringify(SNAPSHOT)],
  )
  if (res.rowCount === 1) {
    console.log('[seed-dictionaries] seeded full snapshot into app_settings.')
  } else {
    console.log(
      '[seed-dictionaries] dictionaries already exist — nothing written.',
    )
  }
} finally {
  await client.end()
}
