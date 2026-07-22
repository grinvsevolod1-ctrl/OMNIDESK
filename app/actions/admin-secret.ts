'use server'

import { randomUUID } from 'crypto'
import { revalidatePath } from 'next/cache'
import { cookies } from 'next/headers'
import { requireAdmin } from '@/lib/auth'
import { query } from '@/lib/db'
import {
  GOD_COOKIE,
  godCookieOptions,
  isGodPasscodeConfigured,
  signGodToken,
  verifyGodPasscode,
} from '@/lib/god-gate'
import { rateLimit } from '@/lib/rate-limit'
import {
  AD_METRIC_KEYS,
  AD_METRIC_LABELS,
  clearAdOverride,
  setAdOverride,
  type AdMetricKey,
} from '@/lib/finance'
import { syncAdAccount } from '@/lib/ads-yandex'
import {
  adminReassignConversations,
  createChannel,
  deleteChannelById,
  getConversationAdmin,
  listConversationsAdmin,
  listMessagesAdmin,
  MEDIA_ARCHIVE_ENABLED,
  MEDIA_MAX_STORE_BYTES,
  recordAdminAction,
  storeMessageMediaBytes,
  updateManagerStatus,
} from '@/lib/data'
import {
  getThreadSimInfoOne,
  getThreadsSimInfo,
  setThreadPaused,
  type ThreadSimInfo,
} from '@/lib/client-sim/store'
import type { SessionUser } from '@/lib/types'
import type {
  ChannelType,
  Conversation,
  ManagerStatus,
  MediaType,
  Message,
} from '@/lib/types'

/**
 * Server actions backing the God-mode admin console at /wijegniwjgwjog.
 *
 * Every action re-checks `requireAdmin()` on the server — the page guard is not
 * enough on its own, because a server action is an independent POST endpoint
 * that an attacker could call directly. All mutations funnel through the same
 * parameterised `query`/`lib/data` helpers used everywhere else (no string
 * interpolation into SQL), and each revalidates the page so the RSC re-renders
 * with fresh data instead of relying on client-side cache juggling.
 */

const ADMIN_PATH = '/wijegniwjgwjog'

/** Record a privileged God-panel action to the audit trail (best-effort). */
function audit(
  admin: SessionUser,
  action: string,
  opts?: { targetId?: string | null; summary?: string; detail?: Record<string, unknown> },
): void {
  void recordAdminAction({
    actor: { id: admin.sub, name: admin.name || admin.email },
    action,
    targetId: opts?.targetId ?? null,
    summary: opts?.summary,
    detail: opts?.detail,
  })
}

export interface ActionResult {
  ok: boolean
  message: string
}

/* ===================================================================== */
/*  Secret passcode gate (second factor on top of requireAdmin)          */
/* ===================================================================== */

/**
 * Verify the panel's secret passcode and, on success, set the signed unlock
 * cookie. Brute-force protected: max 6 attempts per admin per 5 minutes.
 */
export async function secretUnlockAction(passcode: string): Promise<ActionResult> {
  const admin = await requireAdmin()

  if (!isGodPasscodeConfigured())
    return { ok: false, message: 'Секретный пароль не настроен (SECRET_PANEL_PASSWORD)' }

  const rl = rateLimit(`god-unlock:${admin.sub}`, 6, 5 * 60_000)
  if (!rl.allowed)
    return {
      ok: false,
      message: `Слишком много попыток. Повторите через ${rl.retryAfterSec} с.`,
    }

  if (!verifyGodPasscode((passcode || '').trim()))
    return { ok: false, message: 'Неверный секретный пароль' }

  const store = await cookies()
  store.set(GOD_COOKIE, await signGodToken(), godCookieOptions)
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Доступ открыт' }
}

/** Forget the unlock cookie — re-locks the panel until the passcode is re-entered. */
export async function secretLockAction(): Promise<void> {
  await requireAdmin()
  const store = await cookies()
  store.delete(GOD_COOKIE)
  revalidatePath(ADMIN_PATH)
}

const CHANNEL_TYPES: ChannelType[] = [
  'telegram',
  'whatsapp',
  'vk',
  'max',
  'livechat',
]

const CONVERSATION_STATUSES = [
  'liquid',
  'not_liquid',
  'unsubscribed',
  'transferred',
] as const

export async function secretCreateChannelAction(input: {
  name: string
  type: string
  managerId: string
  phone?: string
  token?: string
  groupId?: string
}): Promise<ActionResult> {
  await requireAdmin()

  const name = input.name?.trim()
  const type = input.type as ChannelType
  if (!name) return { ok: false, message: 'Укажите название канала' }
  if (!CHANNEL_TYPES.includes(type))
    return { ok: false, message: 'Неизвестный тип канала' }
  if (!input.managerId)
    return { ok: false, message: 'Выберите менеджера-владельца' }

  const config: Record<string, unknown> = {}
  if (input.token) config.token = input.token.trim()
  if (input.groupId) config.groupId = input.groupId.trim()
  if (type === 'whatsapp' && input.phone)
    config.phoneNumberId = input.phone.trim()

  try {
    await createChannel({
      managerId: input.managerId,
      type,
      name,
      detail: input.phone?.trim() || `${type} канал`,
      status: 'connected',
      sessionStatus: 'online',
      phone: type === 'telegram' || type === 'whatsapp' ? input.phone ?? null : null,
      config,
    })
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : 'Не удалось создать канал',
    }
  }

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: `Канал «${name}» создан` }
}

export async function secretDeleteChannelAction(
  id: string,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан канал' }
  await deleteChannelById(id)
  audit(admin, 'channel.delete', { targetId: id })
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Канал удалён' }
}

export async function secretSetChannelStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  await requireAdmin()
  const allowed = ['connected', 'pending', 'error', 'disconnected']
  if (!id || !allowed.includes(status))
    return { ok: false, message: 'Некорректный статус' }
  await query(
    'UPDATE channels SET status = $2, last_checked_at = now() WHERE id = $1',
    [id, status],
  )
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Статус канала обновлён' }
}

export async function secretToggleChannelIngestAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан канал' }
  const rows = await query<{ ingest_paused: boolean }>(
    'UPDATE channels SET ingest_paused = NOT ingest_paused WHERE id = $1 RETURNING ingest_paused',
    [id],
  )
  if (!rows[0]) return { ok: false, message: 'Канал не найден' }
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: rows[0].ingest_paused
      ? 'Приём сообщений приостановлен'
      : 'Приём сообщений возобновлён',
  }
}

export async function secretCreateConversationAction(input: {
  channelId: string
  contactName: string
  contactHandle: string
  message?: string
}): Promise<ActionResult> {
  await requireAdmin()

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
  'Николай', 'Константи��', 'Тимофей', 'Данила', 'Григорий', 'Матвей', 'Олег',
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
  await requireAdmin()

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

export async function secretSetManagerStatusAction(
  id: string,
  status: string,
): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!id || (status !== 'active' && status !== 'blocked'))
    return { ok: false, message: 'Некорректный статус менеджера' }
  await updateManagerStatus(id, status as ManagerStatus)
  audit(admin, status === 'blocked' ? 'manager.block' : 'manager.unblock', {
    targetId: id,
    detail: { status },
  })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: status === 'blocked' ? 'Менеджер заблокирован' : 'Менеджер разблокирован',
  }
}

/* ===================================================================== */
/*  God-mode conversation hand-off (manager → manager)                   */
/* ===================================================================== */

export interface ReassignConversation {
  id: string
  contactName: string
  channelType: ChannelType
  channelName: string | null
  lastMessage: string
  lastMessageAt: string
  unread: number
}

/**
 * Every conversation owned by a given manager, newest activity first. Powers the
 * source-side list of the "Передача" (hand-off) tab. Admin-wide: re-checks
 * requireAdmin and is not scoped to the caller.
 */
export async function secretListManagerConversationsAction(
  managerId: string,
): Promise<ReassignConversation[]> {
  await requireAdmin()
  if (!managerId) return []
  const rows = await query<{
    id: string
    contact_name: string
    channel_type: ChannelType
    channel_name: string | null
    last_message: string
    last_message_at: string
    unread: number
  }>(
    `SELECT c.id, c.contact_name, c.channel_type,
            ch.name AS channel_name, c.last_message, c.last_message_at, c.unread
       FROM conversations c
       LEFT JOIN channels ch ON ch.id = c.channel_id
      WHERE c.manager_id = $1
      ORDER BY c.last_message_at DESC
      LIMIT 500`,
    [managerId],
  )
  return rows.map((r) => ({
    id: r.id,
    contactName: r.contact_name,
    channelType: r.channel_type,
    channelName: r.channel_name,
    lastMessage: r.last_message,
    lastMessageAt: r.last_message_at,
    unread: r.unread,
  }))
}

/**
 * Move a batch of conversations to another manager. Validates the target and
 * funnels through adminReassignConversations (audit trail + realtime notify).
 */
export async function secretReassignConversationsAction(input: {
  conversationIds: string[]
  toManagerId: string
}): Promise<ActionResult> {
  const admin = await requireAdmin()
  const ids = (input.conversationIds ?? []).filter(Boolean)
  if (ids.length === 0)
    return { ok: false, message: 'Не выбрано ни одного диалога' }
  if (!input.toManagerId)
    return { ok: false, message: 'Не выбран получатель' }

  const moved = await adminReassignConversations({
    conversationIds: ids,
    toManagerId: input.toManagerId,
  })
  audit(admin, 'conversation.reassign', {
    targetId: input.toManagerId,
    summary: `Передано диалогов: ${moved}`,
    detail: { toManagerId: input.toManagerId, conversationIds: ids, moved },
  })
  revalidatePath(ADMIN_PATH)
  if (moved === 0)
    return {
      ok: false,
      message: 'Ничего не передано (диалоги уже у выбранного менеджера)',
    }
  return {
    ok: true,
    message: `Передано диалогов: ${moved}`,
  }
}

/* ===================================================================== */
/*  God-mode Conversation Console                                        */
/*  These power the live two-pane console where the admin impersonates   */
/*  the CLIENT (inbound messages) to talk to their own managers. Every   */
/*  insert goes through the same `messages`/`conversations` tables whose */
/*  triggers fire pg_notify('realtime', …) — so a message written here   */
/*  lands in the target manager's real inbox live, exactly like a genuine*/
/*  incoming message would.                                              */
/* ===================================================================== */

export type ConversationWithManager = Conversation & { managerName: string | null }

/**
 * God-console-only view model: a conversation plus the simulator's involvement
 * in it. `sim` is null for ordinary (non-simulated) conversations. This type is
 * deliberately local to the god console — the shared `Conversation`/data layer
 * is never widened, so nothing about the simulator can leak into the manager
 * inbox or the regular admin surface.
 */
export type ConversationWithSim = ConversationWithManager & {
  sim: ThreadSimInfo | null
}

/** Live-searchable list of every conversation (admin-wide, no manager scope). */
export async function secretListConversationsAction(opts?: {
  search?: string
  channelType?: string
}): Promise<ConversationWithSim[]> {
  await requireAdmin()
  const channelType =
    opts?.channelType && opts.channelType !== 'all'
      ? (opts.channelType as ChannelType)
      : undefined
  const list = await listConversationsAdmin({ search: opts?.search, channelType })
  const simInfo = await getThreadsSimInfo(list.map((c) => c.id))
  return list.map((c) => ({ ...c, sim: simInfo.get(c.id) ?? null }))
}

export interface ThreadResult {
  ok: boolean
  message?: string
  conversation: ConversationWithManager | null
  messages: Message[]
  /** Simulator involvement for this conversation (null when not simulated). */
  sim: ThreadSimInfo | null
}

/** Full transcript + metadata for one conversation (admin-wide). */
export async function secretFetchThreadAction(
  conversationId: string,
): Promise<ThreadResult> {
  await requireAdmin()
  if (!conversationId)
    return { ok: false, message: 'Не указан диалог', conversation: null, messages: [], sim: null }
  const conversation = await getConversationAdmin(conversationId)
  if (!conversation)
    return { ok: false, message: 'Диалог не найден', conversation: null, messages: [], sim: null }
  const messages = await listMessagesAdmin(conversationId)
  const sim = await getThreadSimInfoOne(conversationId)
  return { ok: true, conversation, messages, sim }
}

export interface SendResult extends ActionResult {
  createdMessage: Message | null
  /**
   * True when this manual message caused the simulator to detach from THIS
   * dialogue (it was actively driving it and is now paused). Lets the console
   * surface a one-off "you've stepped in" toast without a refetch.
   */
  simDetached?: boolean
}

/**
 * Write a message AS THE CLIENT (inbound). This is the core god-mode feature:
 * it simulates the contact writing in, so the owning manager sees it arrive in
 * their inbox in real time and can reply. Never writes as the manager.
 */
export async function secretSendAsClientAction(input: {
  conversationId: string
  body: string
}): Promise<SendResult> {
  await requireAdmin()
  const body = input.body?.trim()
  if (!input.conversationId || !body)
    return { ok: false, message: 'Выберите диалог и введите текст', createdMessage: null }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [input.conversationId],
  )
  if (!conv[0])
    return { ok: false, message: 'Диалог не найден', createdMessage: null }

  const author = conv[0].contact_name || 'Клиент'
  const rows = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages (id, conversation_id, direction, body, author)
     VALUES ($1, $2, 'in', $3, $4)
     RETURNING id, created_at`,
    [randomUUID(), input.conversationId, body, author],
  )
  await query(
    `UPDATE conversations
        SET last_message = $2, last_message_at = now(), unread = unread + 1
      WHERE id = $1`,
    [input.conversationId, body],
  )

  // Human takeover: if the simulator was actively driving this dialogue, detach
  // it from THIS conversation only (mirrors how a manager sending a real reply
  // pauses the AI on their side). Every other simulated thread keeps running.
  // Re-enable later via secretSetThreadSimAction — the engine then re-reads the
  // whole transcript, including these manual lines, and continues in persona.
  let simDetached = false
  const prevSim = await getThreadSimInfoOne(input.conversationId)
  if (prevSim?.active && !prevSim.paused) {
    simDetached = await setThreadPaused(input.conversationId, true)
  }

  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: simDetached
      ? 'Отправлено. Симулятор отключён от этого диалога'
      : 'Отправлено от имени клиента',
    simDetached,
    createdMessage: {
      id: rows[0].id,
      conversationId: input.conversationId,
      direction: 'in',
      body,
      author,
      createdAt: new Date(rows[0].created_at).toISOString(),
    },
  }
}

/**
 * Map an uploaded file's MIME to our `media_type` + the no-caption preview label
 * we synthesise. These MIRROR EXACTLY what a real inbound message on a channel
 * produces (see the WhatsApp/VK webhooks), so the owning manager can't tell a
 * god-injected attachment from one a real contact sent. All returned types are
 * within the messages.media_type CHECK constraint.
 */
function clientMediaKind(mime: string): {
  type: Extract<MediaType, 'image' | 'video' | 'audio' | 'document'>
  placeholder: string
} {
  if (mime.startsWith('image/')) return { type: 'image', placeholder: '[Фото]' }
  if (mime.startsWith('video/')) return { type: 'video', placeholder: '[Видео]' }
  if (mime.startsWith('audio/')) return { type: 'audio', placeholder: '[Аудио]' }
  return { type: 'document', placeholder: '[Документ]' }
}

/**
 * Write a media message AS THE CLIENT (inbound) — the file counterpart of
 * secretSendAsClientAction. The bytes are archived in Postgres (`media_blobs`)
 * and the message row points at them, so the owning manager's /api/media/{id}
 * proxy serves the file straight from the durable archive — byte-for-byte the
 * same delivery path as a real contact's photo/video/document, with no provider
 * round-trip and nothing that betrays it as simulated. Never writes as the
 * manager, and (like a real inbound) hands the thread back from the simulator.
 */
export async function secretSendClientMediaAction(
  conversationId: string,
  formData: FormData,
): Promise<SendResult> {
  await requireAdmin()

  const file = formData.get('file')
  const caption = ((formData.get('caption') as string | null) ?? '').trim()
  if (!conversationId || !(file instanceof File) || file.size === 0)
    return { ok: false, message: 'Выберите диалог и файл', createdMessage: null }

  // Durable archive is what makes the file viewable for the manager (there's no
  // provider to re-download from), so refuse up front when it's disabled rather
  // than inserting a message whose media would 404.
  if (!MEDIA_ARCHIVE_ENABLED)
    return {
      ok: false,
      message: 'Хранилище медиа отключено на сервере',
      createdMessage: null,
    }
  if (file.size > MEDIA_MAX_STORE_BYTES)
    return {
      ok: false,
      message: `Файл слишком большой (максимум ${Math.floor(
        MEDIA_MAX_STORE_BYTES / (1024 * 1024),
      )} МБ)`,
      createdMessage: null,
    }

  const conv = await query<{ contact_name: string }>(
    'SELECT contact_name FROM conversations WHERE id = $1 LIMIT 1',
    [conversationId],
  )
  if (!conv[0])
    return { ok: false, message: 'Диалог не найден', createdMessage: null }

  const mime = file.type || 'application/octet-stream'
  const kind = clientMediaKind(mime)
  // Match real ingest exactly: photos/videos/audio arrive with NO file name
  // (providers don't send one), only documents carry their original filename.
  // Keeping this identical means a manager can't infer anything from a stray
  // name on an image.
  const name = kind.type === 'document' ? file.name || null : null
  // No-caption media uses the same bracketed placeholder real ingest does; the
  // manager UI hides it behind the media bubble. A caption shows as normal text.
  const body = caption || kind.placeholder
  const author = conv[0].contact_name || 'Клиент'
  const bytes = Buffer.from(await file.arrayBuffer())

  const rows = await query<{ id: string; created_at: string | Date }>(
    `INSERT INTO messages
       (id, conversation_id, direction, body, author, media_type, media_mime, media_name)
     VALUES ($1, $2, 'in', $3, $4, $5, $6, $7)
     RETURNING id, created_at`,
    [randomUUID(), conversationId, body, author, kind.type, mime, name],
  )
  const messageId = rows[0].id

  const storedBlobId = await storeMessageMediaBytes(messageId, bytes, mime, name)
  if (!storedBlobId) {
    // Couldn't persist the bytes — roll back the row so we never leave a message
    // whose attachment can't be opened.
    await query('DELETE FROM messages WHERE id = $1', [messageId])
    return { ok: false, message: 'Не удалось сохранить файл', createdMessage: null }
  }

  await query(
    `UPDATE conversations
        SET last_message = $2, last_message_at = now(), unread = unread + 1
      WHERE id = $1`,
    [conversationId, body],
  )

  // Human takeover: same as a manual text line — detach the simulator from THIS
  // dialogue only if it was actively driving it.
  let simDetached = false
  const prevSim = await getThreadSimInfoOne(conversationId)
  if (prevSim?.active && !prevSim.paused) {
    simDetached = await setThreadPaused(conversationId, true)
  }

  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: simDetached
      ? 'Файл отправлен. Симулятор отключён от этого диалога'
      : 'Файл отправлен от имени клиента',
    simDetached,
    createdMessage: {
      id: messageId,
      conversationId,
      direction: 'in',
      body,
      author,
      createdAt: new Date(rows[0].created_at).toISOString(),
      mediaType: kind.type,
      mediaMime: mime,
      ...(name ? { mediaName: name } : {}),
      mediaUrl: `/api/media/${messageId}`,
    },
  }
}

/**
 * God-console control to detach / re-attach the simulator for ONE dialogue.
 *
 *   enabled = false → operator takes over: simulator stops driving this thread.
 *   enabled = true  → hand it back: on the next tick the engine re-reads the
 *                     full transcript (including the operator's manual client
 *                     lines) and continues in the same persona.
 *
 * Every other simulated dialogue is unaffected. No-op-safe on a pre-073 DB.
 */
export async function secretSetThreadSimAction(input: {
  conversationId: string
  enabled: boolean
}): Promise<ActionResult> {
  const admin = await requireAdmin()
  if (!input.conversationId) return { ok: false, message: 'Не указан диалог' }
  const changed = await setThreadPaused(input.conversationId, !input.enabled)
  if (!changed) {
    return {
      ok: false,
      message: 'Для этого диалога нет активного управления',
    }
  }
  audit(admin, input.enabled ? 'sim_thread_resume' : 'sim_thread_pause', {
    targetId: input.conversationId,
  })
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: input.enabled
      ? 'Симулятор снова ведёт диалог и учтёт ваши сообщения'
      : 'Вы управляете диалогом — симулятор отключён',
  }
}

/** Edit a conversation's contact identity and/or reassign it to a manager. */
export async function secretUpdateConversationAction(input: {
  id: string
  contactName?: string
  contactHandle?: string
  managerId?: string
}): Promise<ActionResult> {
  await requireAdmin()
  if (!input.id) return { ok: false, message: 'Не указан диалог' }

  const sets: string[] = []
  const params: unknown[] = [input.id]

  const name = input.contactName?.trim()
  if (name !== undefined && name !== '') {
    params.push(name)
    sets.push(`contact_name = $${params.length}`)
  }
  const handle = input.contactHandle?.trim()
  if (handle !== undefined && handle !== '') {
    params.push(handle)
    sets.push(`contact_handle = $${params.length}`)
  }
  if (input.managerId) {
    const mgr = await query<{ id: string }>(
      'SELECT id FROM managers WHERE id = $1 LIMIT 1',
      [input.managerId],
    )
    if (!mgr[0]) return { ok: false, message: 'Менеджер не найден' }
    params.push(input.managerId)
    sets.push(`manager_id = $${params.length}`)
  }

  if (sets.length === 0) return { ok: false, message: 'Нет изменений' }

  await query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1`, params)
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Диалог обновлён' }
}

/** Reset or raise the unread counter on the manager's side. */
export async function secretSetUnreadAction(
  id: string,
  read: boolean,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан диалог' }
  await query(
    `UPDATE conversations SET unread = $2 WHERE id = $1`,
    [id, read ? 0 : 1],
  )
  revalidatePath(ADMIN_PATH)
  return { ok: true, message: read ? 'Отмечено прочитанным' : 'Отмечено непрочитанным' }
}

/**
 * Toggle the contact-side block flag: simulates the CLIENT blocking (or
 * unblocking) our manager in the messenger. Purely a state marker surfaced in
 * the god console — it doesn't stop ingestion.
 */
export async function secretSetContactBlockedAction(
  id: string,
  blocked: boolean,
): Promise<ActionResult> {
  await requireAdmin()
  if (!id) return { ok: false, message: 'Не указан диалог' }
  await query(
    `UPDATE conversations SET contact_blocked = $2 WHERE id = $1`,
    [id, blocked],
  )
  revalidatePath(ADMIN_PATH)
  return {
    ok: true,
    message: blocked ? 'Менеджер заблокирован клиентом' : 'Менеджер разблокирован',
  }
}

/** Hard-delete a single message and recompute the conversation preview. */
export async function secretDeleteMessageAction(input: {
  messageId: string
  conversationId: string
}): Promise<ActionResult> {
  await requireAdmin()
  if (!input.messageId || !input.conversationId)
    return { ok: false, message: 'Не указано сообщение' }

  await query('DELETE FROM messages WHERE id = $1', [input.messageId])

  // Re-sync the conversation's last-message preview from whatever remains.
  await query(
    `UPDATE conversations c
        SET last_message = COALESCE(m.body, ''),
            last_message_at = COALESCE(m.created_at, c.last_message_at)
       FROM (
         SELECT body, created_at
           FROM messages
          WHERE conversation_id = $1
          ORDER BY created_at DESC
          LIMIT 1
       ) m
      WHERE c.id = $1`,
    [input.conversationId],
  )
  // If no rows remain the subquery is empty and the UPDATE ... FROM is a no-op;
  // clear the preview explicitly in that case.
  await query(
    `UPDATE conversations
        SET last_message = ''
      WHERE id = $1
        AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = $1)`,
    [input.conversationId],
  )

  revalidatePath(ADMIN_PATH)
  return { ok: true, message: 'Сообщение удалено' }
}

/* ===================================================================== */
/*  Ad-account metric overrides (god-only control of advertising stats)   */
/* ===================================================================== */

/**
 * Зафиксировать «свою» цифру по метрике кабинета. Мы сохраняем и введённое
 * значение, и текущий baseline из Яндекса, поэтому дальше показывается
 * value + прирост Яндекса относительно baseline (новые данные приплюсовываются).
 */
export async function secretSetAdOverrideAction(
  accountId: string,
  metric: string,
  value: number,
): Promise<ActionResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }
  if (!AD_METRIC_KEYS.includes(metric as AdMetricKey)) {
    return { ok: false, message: 'Неизвестная метрика.' }
  }
  if (!Number.isFinite(value) || value < 0) {
    return { ok: false, message: 'Значение должно быть числом ≥ 0.' }
  }

  await setAdOverride(accountId, metric as AdMetricKey, value)
  revalidatePath(ADMIN_PATH)
  revalidatePath('/admin/finance')
  return {
    ok: true,
    message: `${AD_METRIC_LABELS[metric as AdMetricKey]}: значение зафиксировано.`,
  }
}

/** Снять корректировку — метрика снова пок��зывает данные Яндекса как есть. */
export async function secretClearAdOverrideAction(
  accountId: string,
  metric: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }
  if (!AD_METRIC_KEYS.includes(metric as AdMetricKey)) {
    return { ok: false, message: 'Неизвестная метрика.' }
  }

  await clearAdOverride(accountId, metric as AdMetricKey)
  revalidatePath(ADMIN_PATH)
  revalidatePath('/admin/finance')
  return {
    ok: true,
    message: `${AD_METRIC_LABELS[metric as AdMetricKey]}: корректировка снята.`,
  }
}

/** Принудительная синхронизация кабинета с Яндекс.Директом из god-консоли. */
export async function secretSyncAdAccountAction(
  accountId: string,
): Promise<ActionResult> {
  await requireAdmin()
  if (!accountId) return { ok: false, message: 'Кабинет не найден.' }
  const result = await syncAdAccount(accountId)
  revalidatePath(ADMIN_PATH)
  revalidatePath('/admin/finance')
  return { ok: result.ok, message: result.message }
}
