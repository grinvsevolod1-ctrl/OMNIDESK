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
import { dialogTools } from './tools-dialogs'
import { managerTools } from './tools-managers'
import { channelTools } from './tools-channels'
import { contactTools } from './tools-contacts'
import { financeTools } from './tools-finance'
import { dictionaryTools } from './tools-dictionaries'
import { navigationTools } from './tools-navigation'
import { scheduleTools } from './tools-schedules'
import { aiTools } from './tools-ai'

/**
 * Shared orchestration for the OMNIDESK OS shell copilot, used by BOTH the
 * server action (non-streaming) and the SSE streaming route — same layout as
 * lib/ai-console/run-assistant.ts so the two copilots stay symmetrical.
 */

/**
 * Cheap + fast by default: gpt-4.1-mini is ~5–10x cheaper than gpt-4.1
 * ($0.40/$1.60 vs $2/$8 per 1M tokens via the AI Gateway) and noticeably
 * lower-latency, while keeping reliable tool calling. A turn with several
 * tool calls costs fractions of a cent instead of ~20¢.
 */
const ASSISTANT_MODEL =
  process.env.ADMIN_CONSOLE_ASSISTANT_MODEL ||
  process.env.AI_CONSOLE_ASSISTANT_MODEL ||
  'openai/gpt-4.1-mini'

/** Turns beyond this tail are aggressively truncated (context compression). */
const RECENT_TURNS_FULL = 6
/** Older turns keep only this many characters — enough to preserve context. */
const OLD_TURN_CHARS = 280

/**
 * Normalize raw client history into clean model turns.
 * Cost control: only the last RECENT_TURNS_FULL turns keep their full text
 * (up to 2000 chars); older turns are compressed to OLD_TURN_CHARS. Long
 * dialogs keep the model's context useful while the per-request token bill
 * stays roughly constant instead of growing with the conversation.
 */
export function normalizeTurns(
  history: AssistantTurn[] | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns = (history ?? [])
    .filter((t) => t && typeof t.content === 'string' && t.content.trim())
    .slice(-ASSISTANT_HISTORY_LIMIT)
  const cutoff = Math.max(0, turns.length - RECENT_TURNS_FULL)
  return turns.map((t, i) => {
    const full = t.content.trim().slice(0, 2000)
    const content =
      i < cutoff && full.length > OLD_TURN_CHARS
        ? `${full.slice(0, OLD_TURN_CHARS - 1)}…`
        : full
    return {
      role: t.role === 'assistant' ? ('assistant' as const) : ('user' as const),
      content,
    }
  })
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

/**
 * Human status line per tool, streamed to the shell while the tool runs —
 * long turns show «Ищу диалоги…» instead of dead silence.
 */
const TOOL_STATUS: Record<string, string> = {
  list_dialogs: 'Ищу диалоги…',
  show_dialog: 'Открываю переписку…',
  manager_activity: 'Считаю активность менеджеров…',
  reassign_dialogs: 'Готовлю передачу диалогов…',
  send_message: 'Готовлю сообщение…',
  list_managers: 'Загружаю менеджеров…',
  create_manager: 'Создаю менеджера…',
  block_manager: 'Готовлю блокировку…',
  block_managers: 'Готовлю блокировку…',
  unblock_manager: 'Разблокирую…',
  delete_manager: 'Готовлю удаление…',
  list_directives: 'Читаю директивы ИИ…',
  add_directive: 'Добавляю директиву…',
  update_directive: 'Обновляю директиву…',
  remove_directive: 'Готовлю удаление директивы…',
  list_knowledge: 'Читаю базу знаний…',
  upsert_knowledge: 'Сохраняю знание…',
  remove_knowledge: 'Готовлю удаление знания…',
}

/**
 * Wrap every tool so its start is reported through `onStatus` (SSE `status`
 * frames). Purely additive: without a callback the tools are untouched.
 */
function withStatus<T extends Record<string, unknown>>(
  tools: T,
  onStatus?: (label: string) => void,
): T {
  if (!onStatus) return tools
  for (const [name, t] of Object.entries(tools)) {
    const candidate = t as { execute?: (...args: never[]) => unknown }
    const orig = candidate.execute
    if (typeof orig !== 'function') continue
    candidate.execute = (...args: never[]) => {
      try {
        onStatus(TOOL_STATUS[name] ?? 'Собираю данные…')
      } catch {
        // A broken status sink must never break the tool itself.
      }
      return orig.apply(candidate, args)
    }
  }
  return tools
}

/** Build the tool-calling agent plus per-turn accumulators. */
export function prepareAssistantRun(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  userId: string,
  onStatus?: (label: string) => void,
) {
  const state = createRunState()

  const tools = withStatus(
    {
      ...overviewTools(state),
      ...dialogTools(state),
      ...managerTools(state),
      ...channelTools(state),
      ...contactTools(state),
      ...financeTools(state),
      ...dictionaryTools(state),
      ...navigationTools(state),
      ...scheduleTools(state, userId),
      ...aiTools(state),
    },
    onStatus,
  )

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
