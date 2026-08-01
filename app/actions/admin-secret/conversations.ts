'use server'

import {
  randomUUID,
} from 'crypto'
import {
  revalidatePath,
} from 'next/cache'
import {
  requireAdmin,
} from '@/lib/auth'
import {
  query,
} from '@/lib/db'
import {
  ADMIN_PATH,
  CONVERSATION_STATUSES,
  assertConsoleOrMessenger,
  audit,
  type ActionResult,
} from './shared'

export async function secretCreateConversationAction(input: {
  channelId: string
  contactName: string
  contactHandle: string
  message?: string
}): Promise<ActionResult> {
  await assertConsoleOrMessenger()

  const contactName = input.contactName?.trim()
  const contactHandle = input.contactHandle?.trim()
  if (!input.channelId || !contactName || !contactHandle)
    return { ok: false, message: 'Заполните канал, имя и хэндл контакта' }

  const channel = await query<{ id: string; type: string; manager_id: string | null }>(
    'SELECT id, type, manager_id FROM channels WHERE id = $1 LIMIT 1',
    [input.channelId],
  )
  if (!channel[0]) return { ok: false, message: 'Канал не найден' }
  if (!channel[0].manager_id)
    return {
      ok: false,
      message: 'У канала нет владельца — назначьте менеджера перед созданием диалога',
    }

  const id = randomUUID()
  const firstMessage = input.message?.trim() ?? ''
  await query(
    `INSERT INTO conversations
       (id, channel_id, channel_type, manager_id, contact_name, contact_handle, last_message, last_message_at, status, unread)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now(), 'liquid', $8)`,
    [
      id,
      channel[0].id,
      channel[0].type,
      channel[0].manager_id,
      contactName,
      contactHandle,
      firstMessage,
      firstMessage ? 1 : 0,
    ],
  )

  if (firstMessage) {
    await query(
      `INSERT INTO messages (id, conversation_id, direction, body, author)
       VALUES ($1, $2, 'in', $3, $4)`,
      [randomUUID(), id, firstMessage, contactName],
    )
  }

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: `Диалог с «${contactName}» создан` }
}

export async function secretDeleteConversationAction(
  id: string,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан диалог' }
  await query('DELETE FROM conversations WHERE id = $1', [id])
  audit(admin, 'conversation.delete', { targetId: id })
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Диалог удалён' }
}

/* ===================================================================== */
/*  Bulk conversation generator ("Наплыв")                               */
/*  Spins up N realistic-looking conversations across the chosen channels*/
/*  with randomised contacts, statuses and timestamps spread over a time */
/*  window — simulating a sudden flood/glitch of incoming chats. Each     */
/*  conversation goes through the same tables/triggers as a real one, so  */
/*  they appear live in the owning manager's inbox.                       */
/* ===================================================================== */

// Gendered pools so the first name and surname always agree in gender —
// otherwise "Мария Иванов" looks obviously fake. Surnames are stored in the
// masculine base form; the feminine variant just appends "а"/replaces the
// ending, handled in `femaleSurname`.
const MALE_FIRST_NAMES = [
  'Александр', 'Дмитрий', 'Сергей', 'Иван', 'Максим', 'Андрей', 'Павел',
  'Никита', 'Роман', 'Артём', 'Егор', 'Алексей', 'Михаил', 'Кирилл',
  'Владимир', 'Денис', 'Евгений', 'Антон', 'Илья', 'Владислав', 'Виктор',
  'Николай', 'Константин', 'Тимофей', 'Данила', 'Григорий', 'Матвей', 'Олег',
]

const FEMALE_FIRST_NAMES = [
  'Мария', 'Анна', 'Екатерина', 'Ольга', 'Наталья', 'Виктория', 'Юлия',
  'Дарья', 'Ксения', 'Полина', 'София', 'Елена', 'Татьяна', 'Ирина',
  'Анастасия', 'Алина', 'Марина', 'Валерия', 'Светлана', 'Вероника',
  'Кристина', 'Людмила', 'Оксана', 'Галина', 'Милана', 'Арина', 'Диана',
]

// Masculine base surnames. Feminine form derived at runtime.
const MALE_LAST_NAMES = [
  'Иванов', 'Смирнов', 'Кузнецов', 'Соколов', 'Козлов', 'Морозов', 'Петров',
  'Михайлов', 'Никитин', 'Захаров', 'Волков', 'Фёдоров', 'Егоров', 'Попов',
  'Лебедев', 'Новиков', 'Орлов', 'Павлов', 'Семёнов', 'Голубев', 'Виноградов',
  'Богданов', 'Воробьёв', 'Фролов', 'Беляев', 'Комаров', 'Киселёв', 'Макаров',
]

/** Convert a masculine surname to its feminine form. */
function femaleSurname(male: string): string {
  if (male.endsWith('ий')) return male.slice(0, -2) + 'ая'
  if (male.endsWith('ой')) return male.slice(0, -2) + 'ая'
  return male + 'а'
}

const FAKE_MESSAGES = [
  'Здравствуйте! Хочу устроиться на работу, подскажите как?',
  'Добрый день, интересуют вакансии. Что есть актуального?',
  'Привет! Ищу работу, у вас есть открытые позиции?',
  'Здравствуйте, увидел вакансию — ещё актуальна?',
  'Хочу работать у вас, что нужно для трудоустройства?',
  'Добрый вечер! Расскажите про условия работы и график',
  'Интересует вакансия, какая зарплата и что по опыту?',
  'Здравствуйте, можно узнать подробнее про работу?',
  'Хочу откликнуться на вакансию, куда отправить резюме?',
  'Привет, ищу подработку — рассматриваете без опыта?',
  'Подскажите, оформление официальное? Хочу устроиться',
  'Здравствуйте! Готов выйти на работу, что дальше делать?',
]

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Build a realistic Russian contact name with gender agreement.
 * For the MAX channel we only use a first name (no surname), matching how MAX
 * profiles usually appear.
 */
function randomContactName(type: string): string {
  const male = Math.random() < 0.5
  const first = pickRandom(male ? MALE_FIRST_NAMES : FEMALE_FIRST_NAMES)
  if (type === 'max') return first
  const baseSurname = pickRandom(MALE_LAST_NAMES)
  const surname = male ? baseSurname : femaleSurname(baseSurname)
  return `${first} ${surname}`
}

/** Every channel uses a plain numeric id handle. */
function randomHandle(): string {
  return `id${Math.floor(100_000 + Math.random() * 900_000_000)}`
}

export interface BulkResult extends ActionResult {
  created: number
}

export async function secretBulkCreateConversationsAction(input: {
  count: number
  channelIds?: string[]
  spreadHours: number
  withMessage: boolean
  markUnread: boolean
}): Promise<BulkResult> {
  const admin = await requireAdmin()

  const count = Math.min(Math.max(Math.floor(input.count) || 0, 1), 100)
  const spreadHours = Math.min(Math.max(input.spreadHours || 24, 0), 24 * 90)

  // Only channels that actually have an owner can host a conversation.
  const idFilter = input.channelIds?.length ? input.channelIds : null
  const channels = await query<{ id: string; type: string; manager_id: string }>(
    `SELECT id, type, manager_id
       FROM channels
      WHERE manager_id IS NOT NULL
        AND ($1::text[] IS NULL OR id::text = ANY($1::text[]))`,
    [idFilter],
  )
  if (channels.length === 0)
    return {
      ok: false,
      created: 0,
      message: 'Нет подходящих каналов с назначенным менеджером',
    }

  let created = 0
  for (let i = 0; i < count; i++) {
    const channel = pickRandom(channels)
    const name = randomContactName(channel.type)
    const handle = randomHandle()
    const status = pickRandom(CONVERSATION_STATUSES)
    const offsetMinutes = Math.floor(Math.random() * spreadHours * 60)
    const body = input.withMessage ? pickRandom(FAKE_MESSAGES) : ''
    const unread = input.markUnread && input.withMessage ? 1 : 0
    const convId = randomUUID()

    await query(
      `INSERT INTO conversations
         (id, channel_id, channel_type, manager_id, contact_name, contact_handle,
          last_message, last_message_at, status, unread)
       VALUES ($1, $2, $3, $4, $5, $6, $7,
               now() - make_interval(mins => $8::int), $9, $10)`,
      [
        convId,
        channel.id,
        channel.type,
        channel.manager_id,
        name,
        handle,
        body,
        offsetMinutes,
        status,
        unread,
      ],
    )

    if (input.withMessage) {
      await query(
        `INSERT INTO messages (id, conversation_id, direction, body, author, created_at)
         VALUES ($1, $2, 'in', $3, $4, now() - make_interval(mins => $5::int))`,
        [randomUUID(), convId, body, name, offsetMinutes],
      )
    }
    created++
  }

  audit(admin, 'conversation.bulk_create', {
    summary: `Создано диалогов: ${created}`,
    detail: {
      created,
      requested: count,
      channelIds: input.channelIds ?? null,
      spreadHours,
    },
  })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    created,
    message: `Создано диалогов: ${created}`,
  }
}

/**
 * Reversible "names glitch": toggle the contact_name_hidden flag on every
 * conversation. When hidden, the app renders "NULL" everywhere, but the real
 * name stays in the DB — flipping it back instantly restores all names.
 */
export async function secretSetNamesHiddenAction(
  hidden: boolean,
): Promise<BulkResult> {
  const admin = await requireAdmin()
  const rows = await query<{ id: string }>(
    `UPDATE conversations SET contact_name_hidden = $1 RETURNING id`,
    [hidden],
  )
  const affected = rows.length
  audit(admin, hidden ? 'conversation.names_hide' : 'conversation.names_show', {
    summary: `${hidden ? 'Скрыты' : 'Восстановлены'} имена в ${affected} диалогах`,
    detail: { affected },
  })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    created: affected,
    message: hidden
      ? `Имена скрыты в ${affected} диалогах`
      : `Имена восстановлены в ${affected} диалогах`,
  }
}

export async function secretSetConversationStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id || !CONVERSATION_STATUSES.includes(status as (typeof CONVERSATION_STATUSES)[number]))
    return { ok: false, message: 'Некорректный статус диалога' }
  await query('UPDATE conversations SET status = $2 WHERE id = $1', [id, status])
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Статус диалога обновлён' }
}

export async function secretSendMessageAction(input: {
  conversationId: string
  body: string
  direction: string
}): Promise<ActionResult> {
  await assertConsoleOrMessenger()

  const body = input.body?.trim()
  const direction = input.direction === 'in' ? 'in' : 'out'
  if (!input.conversationId || !body)
    return { ok: false, message: 'Выберите диалог и введите текст' }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [input.conversationId],
  )
  if (!conv[0]) return { ok: false, message: 'Диалог не найден' }

  const author = direction === 'out' ? 'Менеджер' : conv[0].contact_name || 'Клиент'
  await query(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), input.conversationId, direction, body, author],
  )
  await query(
    `UPDATE conversations
        SET last_message = $2,
            last_message_at = now(),
            unread = unread + CASE WHEN $3 = 'in' THEN 1 ELSE 0 END
      WHERE id = $1`,
    [input.conversationId, body, direction],
  )

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Сообщение добавлено в диалог' }
}
