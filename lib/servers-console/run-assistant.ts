import 'server-only'
import { ToolLoopAgent, isStepCount } from 'ai'
import { revalidatePath } from 'next/cache'
import { isBrainConfigured } from '@/lib/ai/manager-brain'
import { classifyByKeywords, type ServersIntent } from './intents'
import {
  ASSISTANT_HISTORY_LIMIT,
  type AssistantResult,
  type AssistantTurn,
} from './assistant'
import { SYSTEM_INSTRUCTIONS } from './prompt'
import { createRunState } from './run-state'
import { serversTools } from './tools'

/**
 * Shared orchestration for the conversational servers assistant, used by BOTH
 * the streaming route and the one-shot fallback. Mirrors lib/ai-console's
 * run-assistant so the two consoles stay behaviourally identical: a ToolLoopAgent
 * over the servers tools, plus a deterministic keyword fallback for when the AI
 * Gateway is unavailable, so the console never dead-ends.
 */

const ASSISTANT_MODEL =
  process.env.SERVERS_CONSOLE_ASSISTANT_MODEL || 'openai/gpt-4.1'

export const SERVERS_PATH = '/admin/servers'

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

/** Natural acknowledgement per intent for the deterministic fallback path. */
export function fallbackReply(intent: ServersIntent): string {
  switch (intent) {
    case 'add_server':
      return 'Чтобы подключить сервер, мне нужны имя, IP-адрес, SSH-порт и пользователь — а сам ключ вы введёте в защищённую форму. Полноценно поговорить смогу, когда появится доступ к ИИ-модели, а пока открою список серверов.'
    case 'deploy':
      return 'Готов запустить установку: дайте ссылку на репозиторий и домен. Автономный агент подключится, когда будет доступ к ИИ-модели, а пока открываю список серверов.'
    case 'logs':
      return 'Открываю серверы — там видно приложения и их деплои с живыми логами.'
    case 'servers':
      return 'Открываю список серверов.'
    default:
      return 'Пока ИИ-ключ не настроен, я открою список серверов — а полноценно поговорить и запускать установку сможем, когда появится доступ к модели.'
  }
}

/**
 * Build the tool-calling agent plus the per-turn accumulators. The return type
 * is intentionally inferred (the tool-set type is complex); callers get
 * `{ agent, messages, finalize }`.
 */
export function prepareAssistantRun(
  turns: Array<{ role: 'user' | 'assistant'; content: string }>,
) {
  const state = createRunState()
  const tools = serversTools(state)

  const agent = new ToolLoopAgent({
    model: ASSISTANT_MODEL,
    tools,
    stopWhen: isStepCount(12),
    temperature: 0.3,
    instructions: SYSTEM_INSTRUCTIONS,
  })

  const finalize = (text: string): AssistantResult => {
    const reply =
      text?.trim() ||
      (state.launchedDeploy
        ? 'Запустил установку — следите за живым логом ниже.'
        : state.credentialRequest
          ? 'Заполните защищённую форму ниже.'
          : state.actions.length
            ? 'Готово.'
            : 'Готово. Чем ещё помочь с серверами?')
    return {
      reply,
      actions: state.actions,
      openPanel: state.openPanel,
      credentialRequest: state.credentialRequest,
      launchedDeploy: state.launchedDeploy,
      dataChanged: state.dataChanged,
      source: 'ai',
    }
  }

  return { agent, messages: turns, finalize }
}

/** Deterministic offline fallback result for a given user utterance. */
function fallbackResult(text: string): AssistantResult {
  const guess = classifyByKeywords(text)
  return {
    reply: fallbackReply(guess.intent),
    actions: [],
    openPanel: { kind: 'servers' },
    credentialRequest: null,
    launchedDeploy: null,
    dataChanged: false,
    source: 'fallback',
  }
}

/**
 * One-shot (non-streaming) turn with the deterministic offline fallback. Used
 * by the streaming route when the gateway is down or nothing was typed.
 */
export async function runAssistantOnce(
  history: AssistantTurn[],
): Promise<AssistantResult> {
  const turns = normalizeTurns(history)
  const text = lastUserText(turns)

  if (!isBrainConfigured() || !text) {
    return fallbackResult(text)
  }

  const run = prepareAssistantRun(turns)
  try {
    const result = await run.agent.generate({ messages: run.messages })
    const out = run.finalize(result.text ?? '')
    if (out.dataChanged) revalidatePath(SERVERS_PATH)
    return out
  } catch {
    return fallbackResult(text)
  }
}
