import 'server-only'
import { addMessage } from '../data'
import {
  getAiAssistSettings,
  isConversationAiLed,
} from '../data/ai-assist'
import {
  assembleBrainInput,
  loadSharedBrainContext,
} from '../ai/assemble-brain-input'
import { dataBrainLoaders } from '../data/brain-loaders'
import { applyActiveExperiment } from '../data/ai-experiments'
import {
  findFollowupCandidates,
  getFollowupSettings,
  recordFollowupTouch,
  type FollowupCandidate,
} from '../data/ai-followup'
import { generateManagerReply, isBrainConfigured } from '../ai/manager-brain'
import { logAi } from '../data/ai-log'
import { enqueueJob } from '../data/jobs'
import { deliverMaxMessage } from '../max-dispatch'
import { deliverVkMessage } from '../vk-dispatch'
import { deliverWhatsappMessage } from '../whatsapp-dispatch'

/**
 * Follow-up autopilot runtime.
 *
 * Gently re-engages clients who went silent, across every channel. Driven by
 * the co-pilot-configured settings (OFF by default) and swept on a schedule by
 * the follow-up cron. Nothing is sent unless an admin explicitly enabled it in
 * chat. It works over AI-enrolled conversations, like the rest of the AI
 * manager.
 */

export interface FollowupSweepResult {
  enabled: boolean
  considered: number
  sent: number
  skipped: number
}

/** True when `now` (in tz) falls inside the quiet window [start, end). */
export function isQuietNow(
  quietStart: number,
  quietEnd: number,
  tz: string,
  now: Date = new Date(),
): boolean {
  // Quiet disabled when start === end (empty window).
  if (quietStart === quietEnd) return false
  let hour: number
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz || 'Europe/Moscow',
        hour: 'numeric',
        hour12: false,
      }).format(now),
    )
  } catch {
    hour = Number(
      new Intl.DateTimeFormat('en-US', {
        timeZone: 'Europe/Moscow',
        hour: 'numeric',
        hour12: false,
      }).format(now),
    )
  }
  hour = hour % 24
  // Overnight window (e.g. 21 → 9): quiet if hour >= start OR hour < end.
  if (quietEnd <= quietStart) return hour >= quietStart || hour < quietEnd
  // Same-day window (e.g. 1 → 6): quiet if start <= hour < end.
  return hour >= quietStart && hour < quietEnd
}

/**
 * Deliver an already-inserted follow-up message to its provider, mirroring the
 * routing the panel uses for a manual reply (see app/actions/account.ts):
 *   • Telegram → worker job queue (MTProto session).
 *   • WhatsApp / MAX / VK → direct Bot/Cloud API.
 *   • Live chat → the inserted 'out' row already NOTIFYs the widget over SSE.
 */
async function deliverNudge(
  cand: FollowupCandidate,
  messageId: string,
  body: string,
): Promise<void> {
  switch (cand.channelType) {
    case 'telegram':
      await enqueueJob({
        channelId: cand.channelId,
        managerId: cand.managerId,
        action: 'send_message',
        payload: { target: cand.contactHandle, body, messageId },
      })
      break
    case 'whatsapp':
      await deliverWhatsappMessage(cand.conversationId, messageId, body)
      break
    case 'max':
      await deliverMaxMessage(cand.conversationId, messageId, body)
      break
    case 'vk':
      await deliverVkMessage(cand.conversationId, messageId, body)
      break
    // livechat: no push needed — addMessage's insert NOTIFYs the widget.
    default:
      break
  }
}

/**
 * One follow-up sweep: find due silent dialogs and send at most one nudge each.
 * Best-effort per dialog — a single failure never aborts the whole sweep.
 * Returns counters for the cron response/log.
 */
export async function runFollowupSweep(
  maxPerRun = 25,
): Promise<FollowupSweepResult> {
  const settings = await getFollowupSettings()
  if (!settings.enabled) {
    return { enabled: false, considered: 0, sent: 0, skipped: 0 }
  }
  // The follow-up feature and the AI itself must both be on, and the brain
  // must be configured, or there's nothing to send.
  if (!isBrainConfigured()) {
    return { enabled: true, considered: 0, sent: 0, skipped: 0 }
  }
  const master = await getAiAssistSettings()
  if (!master.enabled) {
    return { enabled: true, considered: 0, sent: 0, skipped: 0 }
  }
  // Respect quiet hours: skip the whole sweep during the quiet window.
  if (
    isQuietNow(settings.quietStart, settings.quietEnd, settings.quietTz)
  ) {
    return { enabled: true, considered: 0, sent: 0, skipped: 0 }
  }

  const candidates = await findFollowupCandidates({
    delayHours: settings.delayHours,
    maxTouches: settings.maxTouches,
    channels: settings.channels,
    limit: maxPerRun,
  })

  let sent = 0
  let skipped = 0

  // Conversation-independent inputs (lessons, corrections, directives) are the
  // same for every candidate — load them ONCE per sweep, not once per dialog.
  const shared = await loadSharedBrainContext(dataBrainLoaders)

  for (const cand of candidates) {
    try {
      // Re-check AI-lead right before composing: a human may have taken over.
      if (!(await isConversationAiLed(cand.conversationId))) {
        skipped++
        continue
      }

      // Per-dialog context via the shared assembler (RAG keyed on the client's
      // last message from history — an empty query is never embedded).
      const { lessons, corrections, directives, history, memory, knowledge } =
        await assembleBrainInput(cand.conversationId, dataBrainLoaders, {
          shared,
        })

      const touchNo = cand.touchesInStreak + 1
      // Transient, highest-priority instruction for THIS generation only: write
      // a single re-engagement nudge. Not persisted — it just shapes the reply.
      const followupDirective =
        `СИТУАЦИЯ FOLLOW-UP: клиент замолчал после твоего последнего сообщения ` +
        `(это касание №${touchNo} из ${settings.maxTouches}). Напиши ОДНО короткое, ` +
        `тёплое и ненавязчивое сообщение, чтобы вернуть его в диалог и мягко ` +
        `подтолкнуть к следующему шагу. Не повторяй дословно прошлые реплики, ` +
        `не дави и не извиняйся навязчиво. Если по истории уже ясно, что клиент ` +
        `отказался — не пиши ничего лишнего, просто оставь короткое уместное касание.`

      // A/B: keep the nudge on the same experiment branch as the client's
      // regular replies (deterministic per conversation), so one client never
      // hears two different personas mid-thread.
      const exp = await applyActiveExperiment(
        {
          persona: master.persona,
          tone: master.tone,
          aggressiveness: master.aggressiveness,
        },
        cand.conversationId,
      )

      const reply = await generateManagerReply(
        {
          persona: exp.settings.persona,
          tone: exp.settings.tone,
          playbook: master.playbook,
          directives: [followupDirective, ...exp.extraDirectives, ...directives],
          lessons,
          corrections,
          memory,
          knowledge,
          aggressiveness: exp.settings.aggressiveness,
          history,
        },
        undefined,
        {
          model: master.model,
          temperature: master.temperature,
          maxTokens: master.maxTokens,
        },
      )

      if (!reply || !reply.trim()) {
        skipped++
        continue
      }

      // Final guard: a human may have replied while we were composing.
      if (!(await isConversationAiLed(cand.conversationId))) {
        skipped++
        continue
      }

      const msg = await addMessage({
        conversationId: cand.conversationId,
        managerId: cand.managerId,
        body: reply.trim(),
        author: 'ИИ-ассистент',
        byAi: true,
      })
      if (!msg) {
        skipped++
        continue
      }

      await deliverNudge(cand, msg.id, reply.trim())
      await recordFollowupTouch({
        conversationId: cand.conversationId,
        messageId: msg.id,
        touchNo,
      })
      sent++

      void logAi({
        level: 'info',
        source: 'followup',
        event: 'nudge.sent',
        message: `Follow-up касание №${touchNo}: "${reply.trim().slice(0, 160)}"`,
        conversationId: cand.conversationId,
        channelType: cand.channelType,
      })
    } catch (err) {
      skipped++
      console.error('followup sweep: dialog failed:', err)
      void logAi({
        level: 'error',
        source: 'followup',
        event: 'nudge.error',
        message: `Сбой follow-up: ${err instanceof Error ? err.message : String(err)}`,
        conversationId: cand.conversationId,
        channelType: cand.channelType,
      })
    }
  }

  return {
    enabled: true,
    considered: candidates.length,
    sent,
    skipped,
  }
}
