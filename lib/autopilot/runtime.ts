import 'server-only'
import { query } from '../db'
import { addMessage, getLivechatWorkingHoursByChannelId } from '../data'
import {
  getAiAssistSettings,
  getConversationHistoryForAi,
  isConversationAiLed,
  listBrainLessons,
  listManualCorrectionRules,
  markAiHandoffToLiquid,
} from '../data/ai-assist'
import {
  assessLeadReady,
  type BrainLog,
  type BrainMessage,
  generateManagerReply,
  isBrainConfigured,
} from '../ai/manager-brain'
import { logAi } from '../data/ai-log'
import { deliverMaxMessage } from '../max-dispatch'
import { deliverVkMessage } from '../vk-dispatch'
import { deliverWhatsappMessage } from '../whatsapp-dispatch'
import { isOffHoursFor } from '../offhours'
import {
  getActiveAutopilot,
  tryRecordFire,
} from './data'
import {
  type AutopilotRule,
  type MatchInput,
  ruleRequiresDedupe,
  selectRule,
} from './match'

/**
 * Conversations with an AI-lead generation currently in flight. A second
 * inbound can arrive while the model is still composing; without this guard
 * both pass the pre-checks and the visitor receives two answers. Claimed
 * up-front and released in a finally so only one AI reply is generated per
 * conversation at a time. Module-scoped (per Node process) — the live-chat
 * ingest route runs single-instance, matching the worker's guard.
 */
const aiLeadInFlight = new Set<string>()

/**
 * Autopilot runtime for LIVE-CHAT inbound (runs inside the Next.js ingest
 * route). Messenger inbound (Telegram/WhatsApp) is handled separately in the
 * worker, which shares the same pure matcher (lib/autopilot/match.ts).
 *
 * Given a freshly-recorded inbound message, this:
 *   1. loads the manager's active autopilot (master switch + enabled rules),
 *   2. evaluates rules (event + keyword + working-hours + source conditions),
 *   3. dedupes via autopilot_fires, and
 *   4. sends the first matching rule's reply as an outbound message.
 *
 * Live-chat has no ban risk, so the reply is sent near-instantly (no pacing).
 * Best-effort: any error is swallowed so an autopilot failure can never break
 * message ingestion.
 */
export async function runLivechatAutopilot(input: {
  managerId: string
  channelId: string
  conversationId: string
  text: string
}): Promise<void> {
  try {
    // AI-lead takes priority: if the AI is set to lead this conversation, let
    // it generate a full contextual reply and skip the canned-rule engine so
    // the two never both answer.
    const handledByAi = await runLivechatAiLead(input)
    if (handledByAi) return

    const { enabled, rules } = await getActiveAutopilot(input.managerId)
    if (!enabled || rules.length === 0) return

    // Is this the first inbound of the conversation? (recordLivechatInbound has
    // already inserted it, so a count of exactly 1 means it's the first.)
    const inboundRows = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM messages
        WHERE conversation_id = $1 AND direction = 'in'`,
      [input.conversationId],
    )
    const isFirstMessage = Number(inboundRows[0]?.n ?? 0) <= 1

    // Only resolve working hours if at least one rule actually needs them.
    let insideWorkingHours: boolean | null = null
    const needsWorkingHours = rules.some(
      (r) => r.config.requireWorkingHours !== 'any',
    )
    if (needsWorkingHours) {
      const wh = await getLivechatWorkingHoursByChannelId(input.channelId)
      insideWorkingHours = wh ? !isOffHoursFor(wh) : null
    }

    const matchInput: MatchInput = {
      mode: 'inbound',
      text: input.text,
      channelId: input.channelId,
      isFirstMessage,
      insideWorkingHours,
    }

    const rule = selectRule(rules, matchInput)
    if (!rule) return

    const replyText = rule.config.replyText.trim()
    if (!replyText) return

    // Dedupe: claim the fire before sending so concurrent inbounds can't
    // double-send. If the claim fails the rule already fired on this conv.
    if (ruleRequiresDedupe(rule)) {
      const claimed = await tryRecordFire(rule.id, input.conversationId)
      if (!claimed) return
    }

    await sendAutoReply(input.managerId, input.conversationId, replyText, rule)
  } catch (err) {
    console.error('[v0] autopilot(livechat) failed:', err)
  }
}

/**
 * AI-lead for live chat: when the AI is set to lead THIS conversation and the
 * global assistant is enabled, generate a full contextual reply with the shared
 * brain (persona + tone + playbook + correction lessons + thread history) and
 * send it as an outbound message authored as the AI. Returns true when it
 * handled the inbound (so canned rules are skipped). Best-effort — any failure
 * returns false so canned autopilot can still try.
 */
async function runLivechatAiLead(input: {
  managerId: string
  channelId: string
  conversationId: string
  text: string
}): Promise<boolean> {
  // Diagnostics sink for this conversation — everything lands in the panel
  // "Логи" tab tagged to this thread/channel.
  const log: BrainLog = (e) =>
    void logAi({
      level: e.level,
      source: 'brain',
      event: e.event,
      message: e.message,
      conversationId: input.conversationId,
      channelType: 'livechat',
      meta: e.meta ?? null,
    })

  // Single-flight per conversation: if a reply is already being generated for
  // this thread, treat this inbound as handled so we never double-answer.
  if (aiLeadInFlight.has(input.conversationId)) return true

  try {
    if (!isBrainConfigured()) {
      void logAi({
        level: 'error',
        source: 'ai-lead',
        event: 'skip.no_key',
        message:
          'ИИ не настроен: отсутствует AI_GATEWAY_API_KEY. Ответы не отправляются.',
        conversationId: input.conversationId,
        channelType: 'livechat',
      })
      return false
    }
    if (!(await isConversationAiLed(input.conversationId))) {
      void logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'skip.not_led',
        message:
          'Диалог не ведётся ИИ (мастер-выключатель выключен или диалог на паузе) — пропускаю.',
        conversationId: input.conversationId,
        channelType: 'livechat',
      })
      return false
    }
    const settings = await getAiAssistSettings()
    if (!settings.enabled) {
      void logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'skip.master_off',
        message: 'Мастер-выключатель ИИ выключен — ответ не отправляется.',
        conversationId: input.conversationId,
        channelType: 'livechat',
      })
      return false
    }

    aiLeadInFlight.add(input.conversationId)

    void logAi({
      level: 'debug',
      source: 'ai-lead',
      event: 'inbound',
      message: `Новое сообщение клиента: "${input.text.slice(0, 200)}" — готовлю ответ.`,
      conversationId: input.conversationId,
      channelType: 'livechat',
    })

    const [lessons, corrections, history] = await Promise.all([
      listBrainLessons(12),
      listManualCorrectionRules(60),
      getConversationHistoryForAi(input.conversationId, 16),
    ])

    const reply = await generateManagerReply(
      {
        persona: settings.persona,
        tone: settings.tone,
        playbook: settings.playbook,
        lessons,
        corrections,
        history,
      },
      log,
    )
    if (!reply) {
      void logAi({
        level: 'warn',
        source: 'ai-lead',
        event: 'no_reply',
        message: 'ИИ не сформировал ответ — клиенту ничего не отправлено.',
        conversationId: input.conversationId,
        channelType: 'livechat',
      })
      return false
    }

    // Re-check the AI-lead flag right before sending: a human may have sent a
    // manual reply (which clears the flag) while we were composing. If so, bail
    // out so the AI doesn't talk over the human.
    if (!(await isConversationAiLed(input.conversationId))) {
      void logAi({
        level: 'info',
        source: 'ai-lead',
        event: 'handover.during_gen',
        message:
          'Пока ИИ готовил ответ, в диалог вошёл человек — отправка отменена.',
        conversationId: input.conversationId,
        channelType: 'livechat',
      })
      return true
    }

    await sendAiReply(input.managerId, input.conversationId, reply)
    void logAi({
      level: 'info',
      source: 'ai-lead',
      event: 'reply.sent',
      message: `Ответ отправлен клиенту: "${reply.slice(0, 200)}"`,
      conversationId: input.conversationId,
      channelType: 'livechat',
    })

    // After replying, judge whether the client is now ready to hand over their
    // data and start working. If so, promote the lead to «Ликвид» and hand it
    // to a human (pauses the AI + flags the inbox banner). Best-effort: never
    // let a promotion failure affect the reply we already sent.
    //
    // Cost guard: the readiness check is a second gateway call on every turn, so
    // we skip it entirely until the client's own recent messages actually show
    // a readiness signal (agreement / sharing contacts). This cuts the vast
    // majority of assessment calls without missing the moment a lead converts.
    try {
      if (!clientShowsReadinessSignal(history)) {
        return true
      }
      const ready = await assessLeadReady(
        [...history, { role: 'manager', body: reply }],
        log,
      )
      if (ready) {
        const promoted = await markAiHandoffToLiquid(input.conversationId)
        if (promoted) {
          console.log(
            '[v0] AI promoted lead to «Ликвид»:',
            input.conversationId,
          )
          void logAi({
            level: 'info',
            source: 'handoff',
            event: 'promoted',
            message:
              'ИИ передал лид человеку: статус повышен до «Ликвид», ИИ поставлен на паузу.',
            conversationId: input.conversationId,
            channelType: 'livechat',
          })
        }
      }
    } catch (err) {
      console.error('[v0] autopilot(livechat) readiness check failed:', err)
    }
    return true
  } catch (err) {
    console.error('[v0] autopilot(livechat) AI-lead failed:', err)
    void logAi({
      level: 'error',
      source: 'ai-lead',
      event: 'error',
      message: `Сбой ИИ-лида: ${err instanceof Error ? err.message : String(err)}`,
      conversationId: input.conversationId,
      channelType: 'livechat',
    })
    return false
  } finally {
    aiLeadInFlight.delete(input.conversationId)
  }
}

/**
 * Cheap, dependency-free pre-filter for the readiness assessment. Returns true
 * only when the CLIENT's recent messages hint they might be agreeing / handing
 * over contacts — the only situations where the (paid) AI readiness check is
 * worth running. Deliberately a bit generous so we never miss a real
 * conversion; the AI call then makes the final confident call.
 */
function clientShowsReadinessSignal(history: BrainMessage[]): boolean {
  const clientLines = history
    .filter((m) => m.role === 'client')
    .slice(-3)
    .map((m) => m.body.toLowerCase())
  if (clientLines.length === 0) return false
  const text = clientLines.join(' \n ')

  // Agreement / commitment phrasing.
  const AGREE =
    /\b(да|давай|согласен|согласна|готов|готова|хорошо|ок|окей|договорились|подходит|устраивает|начн[её]м|поехали|интересно|где начать|что дальше|куда писать|скинь|скиньте|скину|отправлю|записывайте)\b/i
  // Sharing / offering to share contact or personal data.
  const CONTACT =
    /(\+?\d[\d\s\-()]{8,}|@[a-z0-9_]{3,}|телефон|номер|вотсап|whatsapp|вайбер|телеграм|телег[еу]|почт[аеу]|карт[аеуы]|паспорт|реквизит|мои данные|мой ном)/i

  return AGREE.test(text) || CONTACT.test(text)
}

/** Send an AI-authored reply, keeping the AI-lead flag on (byAi). */
async function sendAiReply(
  managerId: string,
  conversationId: string,
  body: string,
): Promise<void> {
  const msg = await addMessage({
    conversationId,
    managerId,
    body,
    author: 'ИИ-ассистент',
    byAi: true,
  })
  if (msg) {
    await deliverMaxMessage(conversationId, msg.id, body)
    await deliverVkMessage(conversationId, msg.id, body)
    await deliverWhatsappMessage(conversationId, msg.id, body)
  }
}

/** Send the auto-reply as an outbound message authored by the manager. */
async function sendAutoReply(
  managerId: string,
  conversationId: string,
  body: string,
  _rule: AutopilotRule,
): Promise<void> {
  // Author with the manager's display name so the visitor sees a normal reply.
  const nameRows = await query<{ name: string }>(
    'SELECT name FROM managers WHERE id = $1',
    [managerId],
  )
  const author = nameRows[0]?.name?.trim() || 'Поддержка'
  // addMessage inserts the outbound row; the DB notify trigger delivers it to
  // both the widget (SSE) and the manager's inbox in real time.
  // byAi: automated sends must not clear the AI-lead flag (only a human reply
  // does). Canned autopilot is automated, so mark it accordingly.
  const msg = await addMessage({ conversationId, managerId, body, author, byAi: true })
  // Webhook-based channels have no SSE widget — the reply must be pushed to the
  // provider. Both dispatchers no-op for conversations they don't own, so it's
  // safe to call them unconditionally.
  if (msg) {
    await deliverMaxMessage(conversationId, msg.id, body)
    await deliverVkMessage(conversationId, msg.id, body)
    await deliverWhatsappMessage(conversationId, msg.id, body)
  }
}
