import 'server-only'
import { ToolLoopAgent, isStepCount } from 'ai'
import { revalidatePath } from 'next/cache'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import { listCopilotNotes } from '@/lib/data/ai-copilot'
import { classifyByKeywords, type ConsoleIntent } from './intents'
import {
  ASSISTANT_HISTORY_LIMIT,
  type AssistantResult,
  type AssistantTurn,
} from './assistant'
import { SYSTEM_INSTRUCTIONS } from './prompt'
import { createRunState } from './run-state'
import { settingsTools } from './tools-settings'
import { knowledgeTools } from './tools-knowledge'
import { directiveTools } from './tools-directives'
import { dialogTools } from './tools-dialogs'
import { analyticsTools } from './tools-analytics'
import { qualityTools } from './tools-quality'

/**
 * Shared orchestration for the AI-manager co-pilot, used by BOTH the server
 * action (non-streaming) and the streaming route handler. Keeping it in one
 * place means the tools, scope-lock prompt, guarded actions and offline
 * fallback can never drift between the two entry points.
 *
 * The former monolith is split by domain; this module only assembles it:
 *   prompt.ts            system instructions (verbatim, model-facing)
 *   run-state.ts         per-turn mutable state every tool writes into
 *   tools-settings.ts    seller config: switch/tone/persona/model/panels
 *   tools-knowledge.ts   knowledge base + training lessons + search
 *   tools-directives.ts  durable admin-dictated rules + audit
 *   tools-dialogs.ts     attach/detach AI, transcripts, follow-up config
 *   tools-analytics.ts   performance, heat, health, briefing, reports, losses
 *   tools-quality.ts     preview, check cases, business memory, experiments
 */

const ASSISTANT_MODEL =
  process.env.AI_CONSOLE_ASSISTANT_MODEL || 'openai/gpt-4.1'

export const AI_PATH = '/admin/ai'

/** Normalize raw client history into clean model turns. */
export function normalizeTurns(
  history: AssistantTurn[] | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return (history ?? [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .slice(-ASSISTANT_HISTORY_LIMIT)
    .map((t) => ({
      role:
        t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: t.content.trim().slice(0, 2000),
    }))
}

/** The latest user utterance from a normalized turn list. */
export function lastUserText(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  return [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''
}

/** Natural acknowledgement per panel for the deterministic fallback path. */
export function fallbackReply(intent: ConsoleIntent): string {
  switch (intent) {
    case 'settings':
      return 'Открываю настройки ИИ-менеджера.'
    case 'aggressiveness':
      return 'Открываю настройку агрессивности продаж.'
    case 'knowledge':
      return 'Открываю базу знаний.'
    case 'training':
      return 'Открываю обучение ассистента.'
    case 'corrections':
      return 'Открываю правки и правила.'
    case 'dialogs':
      return 'Открываю диалоги под управлением ИИ.'
    case 'logs':
      return 'Открываю логи и диагностику.'
    default:
      return 'Пока ИИ-ключ не настроен, я открою нужный раздел — а полноценно поговорить сможем, когда появится доступ к модели.'
  }
}

/**
 * Build the tool-calling agent plus the per-turn accumulators. High-impact
 * actions (disabling the AI, maxing aggressiveness) are GUARDED: instead of
 * applying, they record a `pending` confirmation the UI must approve. The
 * return type is intentionally inferred (the agent's tool-set type is complex);
 * callers get `{ agent, messages, finalize }`.
 */
export async function prepareAssistantRun(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  // One shared mutable state per turn — every tool module closes over it,
  // exactly like the closure variables they shared before the split.
  const state = await createRunState()

  const tools = {
    ...settingsTools(state),
    ...knowledgeTools(state),
    ...directiveTools(state),
    ...dialogTools(state),
    ...analyticsTools(state),
    ...qualityTools(state),
  }

  // Long-term business memory survives the trimmed chat history: every note
  // the admin asked to remember rides along in the system prompt, so the
  // co-pilot stops re-asking about things it was already told. Best-effort —
  // a failed read must never take the whole assistant down.
  const notes = await listCopilotNotes().catch(() => [])
  const memoryBlock =
    notes.length > 0
      ? [
          '',
          'ДОЛГАЯ ПАМЯТЬ О БИЗНЕСЕ АДМИНА (ты сохранил это раньше; опирайся на эти факты и не переспрашивай их заново):',
          ...notes.map((n) => `• ${n.body}`),
        ].join('\n')
      : ''

  const agent = new ToolLoopAgent({
    model: ASSISTANT_MODEL,
    tools,
    stopWhen: isStepCount(12),
    temperature: 0.3,
    instructions: SYSTEM_INSTRUCTIONS + memoryBlock,
  })

  const finalize = (text: string): AssistantResult => {
    const reply =
      text?.trim() ||
      (state.pending
        ? 'Это важное изменение — подтвердите, пожалуйста.'
        : state.actions.length
          ? 'Готово.'
          : 'Готово. Чем ещё помочь по ИИ-менеджеру?')
    return {
      reply,
      actions: state.actions,
      openPanel: state.openPanel,
      settingsChanged: state.settingsChanged,
      pending: state.pending,
      report: state.report,
      source: 'ai',
    }
  }

  return { agent, messages: turns, finalize }
}

/**
 * One-shot (non-streaming) turn with the deterministic offline fallback. Used
 * by the server action and by the streaming route when the gateway is down.
 */
export async function runAssistantOnce(
  history: AssistantTurn[],
): Promise<AssistantResult> {
  const turns = normalizeTurns(history)
  const text = lastUserText(turns)

  if (!isBrainConfigured() || !text) {
    const guess = classifyByKeywords(text)
    return {
      reply: fallbackReply(guess.intent),
      actions: [],
      openPanel: guess.intent === 'help' ? null : guess.intent,
      settingsChanged: false,
      pending: null,
      source: 'fallback',
    }
  }

  const run = await prepareAssistantRun(turns)
  try {
    const result = await run.agent.generate({ messages: run.messages })
    const out = run.finalize(result.text ?? '')
    if (out.settingsChanged) revalidatePath(AI_PATH)
    return out
  } catch {
    const guess = classifyByKeywords(text)
    return {
      reply: fallbackReply(guess.intent),
      actions: [],
      openPanel: guess.intent === 'help' ? null : guess.intent,
      settingsChanged: false,
      pending: null,
      source: 'fallback',
    }
  }
}
