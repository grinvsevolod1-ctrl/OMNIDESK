'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  assignProxy,
  createProxy,
  deleteProxy,
  getProxyById,
} from '@/lib/data'
import { checkProxy } from '@/lib/worker-client'
import type { ProxyKind } from '@/lib/types'

export interface ProxyResult {
  ok: boolean
  message: string
}

const KINDS: ProxyKind[] = ['socks5', 'http', 'mtproto']

/** Admin: add a proxy to the shared pool, optionally assigned to a manager. */
export async function createProxyAction(
  formData: FormData,
): Promise<ProxyResult> {
  await requireAdmin()
  const label = String(formData.get('label') ?? '').trim()
  const kind = String(formData.get('kind') ?? 'socks5') as ProxyKind
  const host = String(formData.get('host') ?? '').trim()
  const port = Number(String(formData.get('port') ?? '').trim())
  const username = String(formData.get('username') ?? '').trim() || null
  const password = String(formData.get('password') ?? '').trim() || null
  const secret = String(formData.get('secret') ?? '').trim() || null
  const managerId = String(formData.get('managerId') ?? '').trim() || null

  if (!label) return { ok: false, message: 'Give the proxy a label.' }
  if (!KINDS.includes(kind)) return { ok: false, message: 'Invalid proxy type.' }
  if (!host) return { ok: false, message: 'Host is required.' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: 'Enter a valid port (1–65535).' }
  }
  if (kind === 'mtproto' && !secret) {
    return { ok: false, message: 'MTProto proxies require a secret.' }
  }

  await createProxy({
    createdByRole: 'admin',
    managerId,
    label,
    kind,
    host,
    port,
    username,
    password,
    secret,
  })
  revalidatePath('/admin/proxies')
  return { ok: true, message: 'Proxy added. Credentials are encrypted at rest.' }
}

/** Admin: assign (managerId) or unassign (null) a proxy. */
export async function assignProxyAction(
  proxyId: string,
  managerId: string | null,
): Promise<ProxyResult> {
  await requireAdmin()
  await assignProxy(proxyId, managerId)
  revalidatePath('/admin/proxies')
  return {
    ok: true,
    message: managerId ? 'Proxy assigned.' : 'Proxy unassigned.',
  }
}

export async function deleteProxyAction(id: string): Promise<ProxyResult> {
  await requireAdmin()
  await deleteProxy(id)
  revalidatePath('/admin/proxies')
  return { ok: true, message: 'Proxy removed.' }
}

/** Admin: ask the worker to test connectivity through the proxy. */
export async function checkProxyAction(id: string): Promise<ProxyResult> {
  await requireAdmin()
  const proxy = await getProxyById(id)
  if (!proxy) return { ok: false, message: 'Proxy not found.' }

  const res = await checkProxy(id)
  revalidatePath('/admin/proxies')
  if (!res) {
    return {
      ok: false,
      message: 'Worker unreachable — start the worker to run proxy checks.',
    }
  }
  // Per-destination summary: `telegram` is a real MTProto-DC tunnel check
  // (what GramJS actually needs), `https` is generic web traffic.
  const reachSummary = res.reach
    ? ` Telegram DC: ${res.reach.telegram ? 'OK' : 'нет'}, HTTPS: ${
        res.reach.https ? 'OK' : 'нет'
      }.`
    : ''

  if (res.ok && !res.error) {
    return {
      ok: true,
      message: `Proxy is working (${res.latencyMs ?? '?'} ms).${reachSummary}`,
    }
  }
  if (res.ok && res.error) {
    // Usable, but with a caveat (e.g. WhatsApp blocked) — surface as a warning.
    return { ok: false, message: `${res.error}${reachSummary}` }
  }
  return {
    ok: false,
    message: `${res.error || 'Proxy check failed.'}${reachSummary}`,
  }
}
