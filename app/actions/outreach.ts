'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import { postJsonToWorker } from '@/lib/worker-client'
import { getWarmupConfig } from '@/lib/data/outreach-config'
import {
  addLeadMessage,
  getLeadForManager,
  listLeadMessages,
  listLeadsForManager,
  markLeadContacted,
  setLeadStatus,
  type OutreachLead,
  type OutreachLeadStatus,
  type OutreachMessage,
} from '@/lib/data/outreach-leads'
import {
  listSendableAccounts,
  markAccountSent,
  markAccountSpamblocked,
  parkAccount,
} from '@/lib/data/outreach-accounts'
import { writeAudit } from '@/lib/data/audit'
import { varyFirstTouch } from '@/lib/outreach-vary'

export interface OutreachSendResult {
  ok: boolean
  message: string
}

/** Очередь лидов текущего менеджера (свежие сверху). */
export async function listMyOutreachLeadsAction(): Promise<OutreachLead[]> {
  const session = await requireManager()
  return listLeadsForManager(session.sub)
}

/** Тред первого касания по лиду (со скоупом по менеджеру). */
export async function getOutreachThreadAction(
  leadId: string,
): Promise<OutreachMessage[]> {
  const session = await requireManager()
  const lead = await getLeadForManager(leadId, session.sub)
  if (!lead) return []
  return listLeadMessages(leadId)
}

/**
 * Менеджер пишет лиду ПЕРВЫМ с прогретого аккаунта пула.
 *
 * Выбор аккаунта: онлайн + прогрет (ready) + без спам-блока + в пределах
 * дневного/часового капа (анти-бан). Отправка идёт через проверенный
 * worker-эндпоинт /personal/start-dialog (тот же, что и у god-панели), после
 * чего фиксируем исходящее в снимке треда и помечаем лид «написали первым».
 */
export async function sendFirstOutreachMessageAction(input: {
  leadId: string
  message: string
}): Promise<OutreachSendResult> {
  const session = await requireManager()

  const text = (input.message ?? '').trim()
  if (!text) return { ok: false, message: 'Введите текст первого сообщения.' }

  const lead = await getLeadForManager(input.leadId, session.sub)
  if (!lead) return { ok: false, message: 'Лид не найден.' }
  if (lead.status === 'contacted' || lead.status === 'replied') {
    return { ok: false, message: 'Этому лиду уже написали.' }
  }

  const target = lead.username
    ? `@${lead.username.replace(/^@+/, '')}`
    : lead.phone
      ? lead.phone
      : lead.tgUserId
  if (!target) {
    return {
      ok: false,
      message: 'У лида нет ни @username, ни телефона — написать первым нельзя.',
    }
  }

  // Анти-бан: подбираем аккаунт в пределах капов из настроек прогрева.
  const warmup = await getWarmupConfig()
  const dailyCap = warmup.dailyCapRamp.length
    ? Math.max(...warmup.dailyCapRamp)
    : 30
  const accounts = await listSendableAccounts({
    managerId: session.sub,
    dailyCap,
    hourlyCap: warmup.hourlyCap,
  })
  const account = accounts[0]
  if (!account || !account.channelId) {
    return {
      ok: false,
      message:
        'Нет готовых аккаунтов для отправки: все на прогреве, в лимите или со спам-блоком. Попробуйте позже.',
    }
  }

  // Анти-бан: уникализируем текст под конкретного лида (Telegram банит
  // байт-в-байт одинаковые первые сообщения незнакомцам).
  const outbound = varyFirstTouch(text, {
    id: lead.id,
    displayName: lead.displayName,
    username: lead.username,
  })

  const data = await postJsonToWorker<{
    started?: boolean
    peerId?: string
    error?: string
  }>('/personal/start-dialog', {
    channelId: account.channelId,
    target,
    text: outbound,
  })

  if (!data?.started) {
    // Аккаунт сам себя «лечит»: спам-блок → карантин, FLOOD_WAIT → парковка,
    // чтобы следующий подбор взял другой аккаунт, а этот вышел из ротации.
    await penalizeAccountOnError(account.id, data?.error).catch(() => {})
    return {
      ok: false,
      message:
        humanizeWorkerError(data?.error) ??
        'Не удалось отправить сообщение. Попробуйте ещё раз.',
    }
  }

  await addLeadMessage({
    leadId: lead.id,
    accountId: account.id,
    direction: 'out',
    body: outbound,
    providerMsgId: data.peerId ?? null,
  })
  await markLeadContacted(lead.id, account.id)
  await markAccountSent(account.id)

  await writeAudit({
    actorRole: 'manager',
    actorId: session.sub,
    actorLabel: session.name,
    action: 'outreach.first_message',
    entityType: 'outreach_lead',
    entityId: lead.id,
    details: { accountId: account.id, target },
  }).catch(() => {})

  revalidatePath('/app/outreach')
  return {
    ok: true,
    message: `Сообщение отправлено с аккаунта «${account.label}».`,
  }
}

/** Ручная смена статуса лида менеджером (won/lost и т.п.). */
export async function setOutreachLeadStatusAction(
  leadId: string,
  status: OutreachLeadStatus,
): Promise<OutreachSendResult> {
  const session = await requireManager()
  const lead = await getLeadForManager(leadId, session.sub)
  if (!lead) return { ok: false, message: 'Лид не найден.' }
  await setLeadStatus(leadId, status)
  revalidatePath('/app/outreach')
  return { ok: true, message: 'Статус обновлён.' }
}

/**
 * Реакция пула на ошибку отправки: спам-блок → карантин (с датой снятия, если
 * её видно), FLOOD_WAIT → парковка на распарсенное окно (или дефолтный час).
 * Best-effort: любая ошибка апдейта не должна ломать ответ менеджеру.
 */
async function penalizeAccountOnError(
  accountId: string,
  error: string | undefined,
): Promise<void> {
  if (!error) return
  const e = error.toLowerCase()
  if (e.includes('peer flood') || (e.includes('spam') && e.includes('block'))) {
    // Дата снятия из отчёта неизвестна на этом слое — оставляем открытой,
    // spamcheck-раннер воркера позже вернёт аккаунт в строй, увидев 'clean'.
    await markAccountSpamblocked(accountId, null)
    return
  }
  const flood = e.match(/flood_wait_(\d+)/) ?? e.match(/flood.*?(\d+)/)
  if (e.includes('flood') || flood) {
    const seconds = flood ? Number(flood[1]) : 3600
    const jitter = Math.floor(Math.random() * 60)
    const until = new Date(Date.now() + (seconds + jitter) * 1000)
    await parkAccount(accountId, until, `FLOOD_WAIT ${seconds}s`)
  }
}

function humanizeWorkerError(error: string | undefined): string | null {
  if (!error) return null
  const e = error.toLowerCase()
  if (e.includes('flood')) {
    return 'Аккаунт временно ограничен Telegram (FLOOD). Попробуйте позже — система подберёт другой аккаунт.'
  }
  if (e.includes('privacy') || e.includes('not mutual')) {
    return 'Настройки приватности лида не позволяют написать первым с этого аккаунта.'
  }
  if (e.includes('username') && e.includes('not')) {
    return 'Не удалось найти пользователя по @username. Проверьте контакт.'
  }
  if (e.includes('spam') || e.includes('peer flood')) {
    return 'Аккаунт получил спам-блок. Он выведен из ротации до проверки.'
  }
  return 'Не удалось отправить сообщение. Попробуйте ещё раз.'
}
