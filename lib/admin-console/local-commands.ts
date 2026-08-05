import 'server-only'
import {
  getAdminStats,
  getConversationAdmin,
  getManagerPerformance,
  getProxyAnalytics,
  listAdminChannels,
  listAllProxies,
  listConversationsAdmin,
  listManagerActivity,
  listManagers,
  listMessagesAdmin,
} from '@/lib/data'
import { getDictionaries } from '@/lib/data/dictionaries'
import { listDirectives } from '@/lib/data/ai-directives'
import { listKnowledge } from '@/lib/data/ai-assist'
import { listServers } from '@/lib/data/hosting'
import { SERVER_STATUS_RU } from './tools-servers'
import { classifyByKeywords, SHELL_SECTIONS } from './intents'
import type { AssistantResult } from './assistant'
import { cached } from './tool-cache'
import { truncate } from './run-state'

/**
 * Deterministic LOCAL command layer — recognizes the copilot's most common
 * read/navigation commands with regexes and serves them straight from the
 * database, WITHOUT ever calling the AI gateway.
 *
 * Why it exists:
 *  1. Cost/latency: «покажи сводку», «список менеджеров», the clickable
 *     table drill-downs («Покажи диалоги менеджера X», «Покажи переписку с
 *     ...») are exact, machine-generated phrases — paying LLM tokens to parse
 *     them is waste. Locally they answer in one DB round-trip.
 *  2. Resilience: the same layer doubles as the OFFLINE fallback, so when the
 *     gateway is down the copilot still shows real data, not just navigation.
 *
 * Scope is strictly read-only + navigation. Anything that mutates state or
 * needs judgement (compose a message, pick who to block) stays with the LLM.
 */

/** A recognized command produced real views — wrap them as a final result. */
function ok(
  reply: string,
  views: AssistantResult['views'],
  openSection: AssistantResult['openSection'] = null,
): AssistantResult {
  return {
    reply,
    actions: [],
    openSection,
    views,
    pending: null,
    report: null,
    source: 'ai',
  }
}

/** Normalized for matching: lowercase, collapsed spaces, no «ё». */
function norm(text: string): string {
  return text.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim()
}

const PERIOD_WORDS: Array<[RegExp, 'today' | 'week' | 'month']> = [
  [/сегодня|за день/, 'today'],
  [/недел/, 'week'],
  [/месяц/, 'month'],
]

function detectPeriod(q: string): 'today' | 'week' | 'month' {
  for (const [re, p] of PERIOD_WORDS) if (re.test(q)) return p
  return 'today'
}

function periodStartIso(p: 'today' | 'week' | 'month'): string {
  if (p === 'today') {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }
  const days = p === 'week' ? 7 : 30
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()
}

/* ------------------------------ handlers ------------------------------ */

async function statsView(): Promise<AssistantResult> {
  const stats = await cached('admin-stats', getAdminStats)
  return ok('Сводка системы:', [
    { kind: 'stats', title: 'Сводка системы', payload: stats },
  ])
}

async function performanceView(): Promise<AssistantResult> {
  const perf = await cached('manager-performance', getManagerPerformance)
  return ok('Производительность менеджеров:', [
    { kind: 'stats', title: 'Производительность менеджеров', payload: perf },
  ])
}

async function managersView(): Promise<AssistantResult> {
  const managers = await listManagers()
  const rows = managers.map((m) => ({
    id: m.id,
    name: m.name,
    email: m.email,
    status: m.status,
  }))
  return ok(`Менеджеров: ${rows.length}.`, [
    { kind: 'managers', title: 'Менеджеры', payload: rows },
  ])
}

async function channelsView(): Promise<AssistantResult> {
  const [channels, dict] = await Promise.all([
    listAdminChannels(),
    getDictionaries(),
  ])
  const rows = channels.map((c) => ({
    id: c.id,
    type: c.type,
    typeLabel: dict.channelTypes[c.type] ?? c.type,
    name: c.name,
    status: c.status,
    statusLabel: dict.accountStatuses[c.status] ?? c.status,
    managerName: c.managerName ?? null,
  }))
  return ok(`Каналов: ${rows.length}.`, [
    { kind: 'channels', title: 'Каналы', payload: rows },
  ])
}

async function proxiesView(): Promise<AssistantResult> {
  const [proxies, analytics, dict] = await Promise.all([
    listAllProxies(),
    getProxyAnalytics(),
    getDictionaries(),
  ])
  const rows = proxies.map((p) => ({
    id: p.id,
    label: p.label ?? p.host,
    host: p.host,
    status: p.status,
    statusLabel: dict.proxyStatuses[p.status] ?? p.status,
    managerId: p.managerId ?? null,
  }))
  return ok(`Прокси: ${rows.length}.`, [
    { kind: 'proxies', title: 'Прокси', payload: { rows, analytics } },
  ])
}

async function activityView(q: string): Promise<AssistantResult> {
  const period = detectPeriod(q)
  const rows = await listManagerActivity(periodStartIso(period))
  const title =
    period === 'today'
      ? 'Активность менеджеров сегодня'
      : period === 'week'
        ? 'Активность менеджеров за неделю'
        : 'Активность менеджеров за месяц'
  return ok(`${title}:`, [{ kind: 'manager_activity', title, payload: rows }])
}

async function dialogsView(opts: {
  managerId?: string
  unansweredOnly?: boolean
  title?: string
}): Promise<AssistantResult> {
  const rows = await listConversationsAdmin({
    managerId: opts.managerId,
    unansweredOnly: opts.unansweredOnly,
    limit: 30,
  })
  const payload = rows.map((c) => ({
    id: c.id,
    contactName: c.contactName || c.contactHandle,
    channelType: c.channelType,
    channelName: c.channelName ?? null,
    managerName: c.managerName,
    status: c.status ?? null,
    lastMessage: truncate(c.lastMessage ?? '', 80),
    lastMessageAt: c.lastMessageAt,
    unread: c.unread,
  }))
  const title = opts.title ?? 'Диалоги'
  return ok(
    payload.length ? `${title} — ${payload.length}:` : `${title}: пока пусто.`,
    [{ kind: 'dialogs', title, payload }],
  )
}

/** «Покажи диалоги менеджера X» — resolve the name locally, no LLM. */
async function managerDialogs(name: string): Promise<AssistantResult | null> {
  const needle = norm(name)
  if (!needle) return null
  const managers = await listManagers()
  const match = managers.find((m) => {
    const n = norm(m.name)
    return n === needle || n.startsWith(needle) || needle.startsWith(n)
  })
  // Ambiguous or unknown name → let the LLM disambiguate.
  if (!match) return null
  return dialogsView({
    managerId: match.id,
    title: `Диалоги менеджера ${match.name}`,
  })
}

/** «Покажи переписку … (диалог <id>)» — the clickable-row drill-down. */
async function dialogMessages(
  conversationId: string,
): Promise<AssistantResult | null> {
  const convo = await getConversationAdmin(conversationId)
  if (!convo) return null
  const messages = await listMessagesAdmin(conversationId, { limit: 30 })
  const payload = {
    contactName: convo.contactName || convo.contactHandle,
    managerName: convo.managerName,
    channelType: convo.channelType,
    messages: messages.map((m) => ({
      direction: m.direction,
      author: m.author,
      body: truncate(m.body ?? '', 500),
      createdAt: m.createdAt,
    })),
  }
  return ok(`Переписка с ${payload.contactName}:`, [
    { kind: 'messages', title: `Диалог с ${payload.contactName}`, payload },
  ])
}

async function directivesView(): Promise<AssistantResult> {
  const list = await listDirectives()
  const payload = list.map((d) => ({
    id: d.id,
    body: d.body,
    enabled: d.enabled,
    sortOrder: d.sortOrder,
  }))
  return ok(`Директив ИИ: ${payload.length}.`, [
    { kind: 'directives', title: 'Директивы ИИ-менеджера', payload },
  ])
}

async function serversView(): Promise<AssistantResult> {
  const servers = await listServers()
  const payload = servers.map((s) => ({
    id: s.id,
    name: s.name,
    ip: s.ipAddress,
    status: s.status,
    statusLabel: SERVER_STATUS_RU[s.status] ?? s.status,
    cpu: s.metrics?.cpu ?? null,
    memory: s.metrics?.mem ?? null,
    disk: s.metrics?.disk ?? null,
    uptime: s.metrics?.uptime ?? null,
    apps: s.appCount ?? 0,
    lastError: s.lastError,
  }))
  const problems = payload.filter(
    (s) => s.status === 'offline' || s.lastError,
  )
  return ok(
    problems.length
      ? `Серверов: ${payload.length}, с проблемами: ${problems.length} (${problems.map((p) => p.name).join(', ')}).`
      : `Серверов: ${payload.length}, все в порядке.`,
    [{ kind: 'servers', title: 'Серверы', payload }],
  )
}

async function knowledgeView(): Promise<AssistantResult> {
  const list = await listKnowledge()
  const payload = list.map((k) => ({
    id: k.id,
    title: k.title,
    enabled: k.enabled,
    preview: truncate(k.content, 120),
  }))
  return ok(`Статей в базе знаний: ${payload.length}.`, [
    { kind: 'knowledge', title: 'База знаний ИИ', payload },
  ])
}

function helpReply(): AssistantResult {
  return {
    reply:
      'Я управляю всей панелью: сводка и аналитика, менеджеры (создать/заблокировать/диалоги), каналы и прокси, переписки клиентов (показать, ответить, передать другому менеджеру), директивы и база знаний ИИ, финансы, расписания, серверы и деплой приложений. Опасные действия всегда прошу подтвердить. Скажите, что нужно — например «покажи диалоги без ответа», «что с серверами» или «создай менеджера Ивана».',
    actions: [],
    openSection: null,
    views: [],
    pending: null,
    report: null,
    source: 'ai',
  }
}

/* ------------------------------- matcher ------------------------------ */

/**
 * Try to answer `text` locally. Returns null when the utterance is anything
 * beyond the exact patterns below — null ALWAYS means «hand over to the LLM»,
 * so a miss can never produce a wrong answer, only a slower one.
 */
export async function tryLocalCommand(
  text: string,
): Promise<AssistantResult | null> {
  const q = norm(text)
  if (!q || q.length > 200) return null

  // Mutation verbs anywhere in the utterance → ALWAYS the LLM's job, even if
  // the rest of the phrase looks like a read («передай все диалоги без
  // ответа…» is a reassignment, not a listing).
  if (
    /перед[аy]|переназнач|перенеси|создай|добавь|удали|заблокируй|разблокируй|ответь|напиши|отправь|измени|обнови|включи|выключи|поставь|сравни|деплой|deploy|перезапусти|останови/.test(
      q,
    )
  )
    return null

  try {
    // «покажи переписку с «X» (диалог <id>)» — from clickable dialog rows.
    const dlg = /диалог\s+([0-9a-f-]{8,64})/i.exec(q)
    if (dlg && /перепис|покажи|открой|сообщени/.test(q))
      return await dialogMessages(dlg[1])

    // «покажи диалоги менеджера <имя>» — from clickable manager rows.
    const mgr =
      /^(?:покажи |открой )?диалоги менеджера\s+(.+?)\s*$/.exec(q)
    if (mgr) return await managerDialogs(mgr[1])

    // Unanswered dialogs («без ответа», «кто ждет ответа», «непрочитанные»).
    if (
      /диалог|перепис|чат|клиент/.test(q) &&
      /без ответа|ждут ответа|ждет ответа|непрочит/.test(q)
    )
      return await dialogsView({
        unansweredOnly: true,
        title: 'Диалоги без ответа',
      })

    // Recent dialogs («покажи диалоги», «последние переписки»).
    if (/^(?:покажи |открой )?(?:последние )?(?:диалоги|переписки)$/.test(q))
      return await dialogsView({})

    // Manager activity («кто писал сегодня», «активность менеджеров»).
    if (
      /активность менеджер|кто писал|сколько (?:людей|человек) написало/.test(q)
    )
      return await activityView(q)

    // System stats («покажи сводку/статистику/метрики»).
    if (/^(?:покажи |открой )?(?:сводк|статистик|метрик|дашборд)/.test(q))
      return await statsView()

    // Manager performance («производительность», «кто лучше работает»).
    if (/производительност|кто лучше работает|конверсия менеджер/.test(q))
      return await performanceView()

    // Entity lists — exact «покажи X»/«список X» only, so «создай менеджера»
    // or «заблокируй менеджера X» never match.
    if (/^(?:покажи |открой )?(?:список менеджеров|менеджеры|менеджеров)$/.test(q))
      return await managersView()
    if (/^(?:покажи |открой )?(?:каналы|аккаунты|список каналов|список аккаунтов)$/.test(q))
      return await channelsView()
    if (/^(?:покажи |открой )?(?:прокси|список прокси)$/.test(q))
      return await proxiesView()
    if (/^(?:покажи |открой )?(?:директивы|правила ии|директивы ии)$/.test(q))
      return await directivesView()
    if (/^(?:покажи |открой )?(?:база знаний|базу знаний|знания ии)$/.test(q))
      return await knowledgeView()
    if (
      /^(?:покажи |открой )?(?:серверы|список серверов|статус серверов|что с серверами)$/.test(
        q,
      )
    )
      return await serversView()

    // Navigation: «открой раздел X» (explicit — mirrors the system prompt).
    const nav = /^открой (?:раздел )?(.+)$/.exec(q)
    if (nav) {
      const { section } = classifyByKeywords(nav[1])
      const info = SHELL_SECTIONS.find((s) => s.id === section)
      if (info && section !== 'help')
        return ok(`Открываю раздел «${info.title}».`, [], section)
    }

    // Capabilities («что ты умеешь», «помощь», «help»).
    if (/^(?:что ты умеешь|помощь|help|команды)\??$/.test(q))
      return helpReply()
  } catch {
    // Local layer is best-effort: any DB error → defer to the normal path.
    return null
  }

  return null
}
