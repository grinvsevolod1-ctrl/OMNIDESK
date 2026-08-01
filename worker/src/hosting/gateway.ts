import { logger } from '../logger.js'

/**
 * Thin OpenAI-compatible tool-calling client for the Vercel AI Gateway, used by
 * the autonomous deploy agent. Talks to the gateway's REST endpoint over `fetch`
 * (no `ai` SDK in the worker), mirroring how lib/ai/brain calls the same API.
 *
 * Only the small surface the agent needs: a chat-completions call with `tools`
 * that returns either assistant text or a list of tool calls to execute.
 */

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions'

/** Model for the deploy agent. Override with AI_DEPLOY_AGENT_MODEL. */
export const AGENT_MODEL = process.env.AI_DEPLOY_AGENT_MODEL || 'openai/gpt-4.1'

/**
 * Known-good fallback if the configured model is rejected by the gateway (e.g.
 * a typo in AI_DEPLOY_AGENT_MODEL, or a model that was retired). Keeps a deploy
 * from dying outright over a bad model id.
 */
const FALLBACK_MODEL = 'openai/gpt-4o'

/** True when the gateway key is present (agent can run). */
export function isGatewayConfigured(): boolean {
  return Boolean(process.env.AI_GATEWAY_API_KEY)
}

/** JSON-schema-ish parameter definition for a tool. */
export interface ToolParameters {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolDef {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParameters
  }
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
  name?: string
}

export interface ChatTurn {
  content: string | null
  toolCalls: ToolCall[]
}

interface GatewayResponse {
  choices?: Array<{
    message?: {
      content?: string | null
      tool_calls?: ToolCall[]
    }
  }>
}

/**
 * One chat-completions round with tools. Returns the assistant's text and any
 * tool calls it wants executed. Throws on transport/HTTP errors so the caller
 * can surface a clear failure into the deploy log.
 */
export async function chatWithTools(
  messages: ChatMessage[],
  tools: ToolDef[],
  opts: { temperature?: number; signal?: AbortSignal } = {},
): Promise<ChatTurn> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) throw new Error('AI_GATEWAY_API_KEY не задан')

  const call = async (model: string): Promise<Response> =>
    fetch(GATEWAY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages,
        tools,
        tool_choice: 'auto',
        temperature: opts.temperature ?? 0.2,
      }),
      signal: opts.signal,
    })

  let res = await call(AGENT_MODEL)
  // A 400/404 usually means the configured model id is unknown — retry once on a
  // known-good fallback so a bad AI_DEPLOY_AGENT_MODEL doesn't kill the deploy.
  if (!res.ok && (res.status === 400 || res.status === 404) && AGENT_MODEL !== FALLBACK_MODEL) {
    const body = await res.text().catch(() => '')
    logger.warn(
      { status: res.status, model: AGENT_MODEL, body: body.slice(0, 300) },
      'gateway rejected model, retrying with fallback',
    )
    res = await call(FALLBACK_MODEL)
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    logger.warn({ status: res.status, body: body.slice(0, 500) }, 'gateway error')
    throw new Error(`AI Gateway вернул ${res.status}`)
  }

  const data = (await res.json()) as GatewayResponse
  const message = data.choices?.[0]?.message
  return {
    content: message?.content ?? null,
    toolCalls: message?.tool_calls ?? [],
  }
}
