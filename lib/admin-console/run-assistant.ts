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
import { serverTools } from './tools-servers'
import { tryLocalCommand } from './local-commands'
import {
  lastUserText,
  normalizeTurns as coreNormalizeTurns,
  withStatus as coreWithStatus,
} from '@/lib/console-core'

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

/** Normalize raw client history (shared console-core compression rules). */
export function normalizeTurns(
  history: AssistantTurn[] | undefined,
): Array<{ role: 'user' | 'assistant'; content: string }> {
  return coreNormalizeTurns(history, ASSISTANT_HISTORY_LIMIT)
}

export { lastUserText } from '@/lib/console-core'

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
  list_servers: 'Проверяю серверы…',
  show_server_apps: 'Смотрю приложения…',
  deploy_app: 'Готовлю деплой…',
}

/** Build the tool-calling agent plus per-turn accumulators. */
export function prepareAssistantRun(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
  userId: string,
  onStatus?: (label: string) => void,
) {
  const state = createRunState()

  const tools = coreWithStatus(
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
      ...serverTools(state),
    },
    TOOL_STATUS,
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

/**
 * Best available answer WITHOUT the AI gateway: first the deterministic
 * local-command layer (real data views), then keyword navigation.
 */
export async function offlineResult(text: string): Promise<AssistantResult> {
  const local = await tryLocalCommand(text)
  return local ?? fallbackResult(text)
}

/** One-shot (non-streaming) turn with the deterministic offline fallback. */
export async function runAssistantOnce(
  history: AssistantTurn[],
  userId: string,
): Promise<AssistantResult> {
  const turns = normalizeTurns(history)
  const text = lastUserText(turns)

  // Local command layer FIRST: common reads and drill-downs are answered
  // straight from the DB — zero gateway tokens, zero LLM latency.
  const local = text ? await tryLocalCommand(text) : null
  if (local) return local

  if (!isBrainConfigured() || !text) return fallbackResult(text)

  const run = prepareAssistantRun(turns, userId)
  try {
    const result = await run.agent.generate({ messages: run.messages })
    return run.finalize(result.text ?? '')
  } catch {
    return fallbackResult(text)
  }
}
