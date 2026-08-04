import 'server-only'
import { ToolLoopAgent, isStepCount } from 'ai'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import { classifyByKeywords, SHELL_SECTIONS, type ShellSection } from './intents'
import {
  ASSISTANT_HISTORY_LIMIT,
  type AssistantResult,
  type AssistantTurn,
} from './assistant'
import { SYSTEM_INSTRUCTIONS } from './prompt'
import { createRunState } from './run-state'
import { overviewTools } from './tools-overview'
import { managerTools } from './tools-managers'
import { channelTools } from './tools-channels'
import { contactTools } from './tools-contacts'
import { financeTools } from './tools-finance'
import { dictionaryTools } from './tools-dictionaries'
import { navigationTools } from './tools-navigation'
import { scheduleTools } from './tools-schedules'

/**
 * Shared orchestration for the OMNIDESK OS shell copilot, used by BOTH the
 * server action (non-streaming) and the SSE streaming route — same layout as
 * lib/ai-console/run-assistant.ts so the two copilots stay symmetrical.
 */

const ASSISTANT_MODEL =
  process.env.ADMIN_CONSOLE_ASSISTANT_MODEL ||
  process.env.AI_CONSOLE_ASSISTANT_MODEL ||
  'openai/gpt-4.1'

/** Normalize raw client history into clean model turns. */
export function normalizeTurns(
  history: AssistantTurn[] | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return (history ?? [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .slice(-ASSISTANT_HISTORY_LIMIT)
    .map((t) => ({
      role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content: t.content.trim().slice(0, 2000),
    }))
}

/** The latest user utterance from a normalized turn list. */
export function lastUserText(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
): string {
  return [...turns].reverse().find((t) => t.role === 'user')?.content ?? ''
}

/** Deterministic offline fallback: route to the matching section. */
export function fallbackResult(text: string): AssistantResult {
  const { section } = classifyByKeywords(text)
  const info = SHELL_SECTIONS.find((s) => s.id === section)
  return {
    reply: info
      ? `Открываю раздел «${info.title}».`
      : 'Пока ИИ-модель недоступна, я могу открыть нужный раздел — скажите, куда перейти (менеджеры, учёт, аккаунты, контакты...).',
    actions: [],
    openSection: info ? (section as ShellSection) : null,
    views: [],
    pending: null,
    report: null,
    source: 'fallback',
  }
}

/** Build the tool-calling agent plus per-turn accumulators. */
export function prepareAssistantRun(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  userId: string,
) {
  const state = createRunState()

  const tools = {
    ...overviewTools(state),
    ...managerTools(state),
    ...channelTools(state),
    ...contactTools(state),
    ...financeTools(state),
    ...dictionaryTools(state),
    ...navigationTools(state),
    ...scheduleTools(state, userId),
  }

  const agent = new ToolLoopAgent({
    model: ASSISTANT_MODEL,
    tools,
    stopWhen: isStepCount(10),
    temperature: 0.3,
    instructions: SYSTEM_INSTRUCTIONS,
  })

  const finalize = (text: string): AssistantResult => {
    const reply =
      text?.trim() ||
      (state.pending
        ? 'Это важное действие — подтвердите, пожалуйста.'
        : state.actions.length
          ? 'Готово.'
          : 'Готово. Что ещё сделать?')
    return {
      reply,
      actions: state.actions,
      openSection: state.openSection,
      views: state.views,
      pending: state.pending,
      report: state.report,
      source: 'ai',
    }
  }

  return { agent, messages: turns, finalize }
}

/** One-shot (non-streaming) turn with the deterministic offline fallback. */
export async function runAssistantOnce(
  history: AssistantTurn[],
  userId: string,
): Promise<AssistantResult> {
  const turns = normalizeTurns(history)
  const text = lastUserText(turns)

  if (!isBrainConfigured() || !text) return fallbackResult(text)

  const run = prepareAssistantRun(turns, userId)
  try {
    const result = await run.agent.generate({ messages: run.messages })
    return run.finalize(result.text ?? '')
  } catch {
    return fallbackResult(text)
  }
}
