import 'server-only'

/**
 * Live AI Gateway credit balance for the god-panel.
 *
 * The customer-facing manager brain (lib/ai/manager-brain.ts) bills against the
 * Vercel AI Gateway key, so this balance figure covers everything the system
 * spends on inference. We read it straight from the Gateway credits endpoint.
 *
 * Docs: GET https://ai-gateway.vercel.sh/v1/credits with a Bearer key returns
 * `{ balance, total_used }` as decimal-dollar strings.
 */

const CREDITS_URL = 'https://ai-gateway.vercel.sh/v1/credits'

export interface GatewayBalance {
  /** True when we could read a real figure from the Gateway. */
  ok: boolean
  /** Remaining credit in USD (null when unavailable). */
  balance: number | null
  /** Lifetime spend in USD (null when unavailable). */
  totalUsed: number | null
  /**
   * Why the balance is unavailable, for the UI. `no_key` → only an OIDC token is
   * present (Vercel-hosted) which can't read credits; `error` → request failed.
   */
  reason?: 'no_key' | 'error'
  /** Short human message for the failure case. */
  message?: string
}

/**
 * Fetch the current Gateway balance. Never throws — on any failure it returns a
 * tagged "unavailable" result so the panel can render a neutral state instead of
 * crashing the whole god-mode page. Balance reads require an explicit
 * AI_GATEWAY_API_KEY (an OIDC token alone cannot query credits).
 */
export async function getGatewayBalance(): Promise<GatewayBalance> {
  const key = process.env.AI_GATEWAY_API_KEY
  if (!key) {
    return {
      ok: false,
      balance: null,
      totalUsed: null,
      reason: 'no_key',
      message: 'Нет ключа AI_GATEWAY_API_KEY — баланс недоступен',
    }
  }

  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(CREDITS_URL, {
      headers: { authorization: `Bearer ${key}` },
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => clearTimeout(timeout))

    if (!res.ok) {
      return {
        ok: false,
        balance: null,
        totalUsed: null,
        reason: 'error',
        message: `Gateway ответил ${res.status}`,
      }
    }

    const data = (await res.json()) as {
      balance?: string | number
      total_used?: string | number
    }
    const balance = data.balance != null ? Number(data.balance) : null
    const totalUsed = data.total_used != null ? Number(data.total_used) : null

    return {
      ok: true,
      balance: Number.isFinite(balance as number) ? balance : null,
      totalUsed: Number.isFinite(totalUsed as number) ? totalUsed : null,
    }
  } catch (err) {
    return {
      ok: false,
      balance: null,
      totalUsed: null,
      reason: 'error',
      message: err instanceof Error ? err.message : 'Ошибка запроса баланса',
    }
  }
}
