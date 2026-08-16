'use server'

import { revalidatePath } from 'next/cache'
import { requireManager } from '@/lib/auth'
import {
  createProxy,
  deleteProxy,
  getProxyById,
  managerCanUseProxy,
} from '@/lib/data'
import { checkProxy } from '@/lib/worker-client'
import type { ProxyKind } from '@/lib/types'

export interface ProxyResult {
  ok: boolean
  message: string
}

const KINDS: ProxyKind[] = ['socks5', 'http', 'mtproto']

/**
 * Manager: add a proxy they own. It is auto-assigned to the creating manager so
 * it appears in their connect wizard immediately. Managers never touch the admin
 * pool or other managers' proxies.
 */
export async function createManagerProxyAction(
  formData: FormData,
): Promise<ProxyResult> {
  const session = await requireManager()
  const label = String(formData.get('label') ?? '').trim()
  const kind = String(formData.get('kind') ?? 'socks5') as ProxyKind
  const host = String(formData.get('host') ?? '').trim()
  const port = Number(String(formData.get('port') ?? '').trim())
  const username = String(formData.get('username') ?? '').trim() || null
  const password = String(formData.get('password') ?? '').trim() || null
  const secret = String(formData.get('secret') ?? '').trim() || null

  if (!label) return { ok: false, message: 'Укажите название прокси.' }
  if (!KINDS.includes(kind)) return { ok: false, message: 'Неверный тип прокси.' }
  if (!host) return { ok: false, message: 'Укажите хост.' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, message: 'Введите корректный порт (1–65535).' }
  }
  if (kind === 'mtproto' && !secret) {
    return { ok: false, message: 'Для MTProto нужен secret.' }
  }

  await createProxy({
    createdByRole: 'manager',
    createdByManagerId: session.sub,
    label,
    kind,
    host,
    port,
    username,
    password,
    secret,
  })
  revalidatePath('/app/proxies')
  revalidatePath('/app/connections')
  return { ok: true, message: 'Прокси добавлен. Данные зашифрованы.' }
}

/** Manager: delete one of THEIR OWN proxies (scoped — admin proxies are safe). */
export async function deleteManagerProxyAction(
  id: string,
): Promise<ProxyResult> {
  const session = await requireManager()
  const removed = await deleteProxy(id, session.sub)
  if (!removed) {
    return {
      ok: false,
      message: 'Можно удалять только свои прокси.',
    }
  }
  revalidatePath('/app/proxies')
  revalidatePath('/app/connections')
  return { ok: true, message: 'Прокси удалён.' }
}

/**
 * Manager: run a connectivity check on a proxy they own OR that is assigned to
 * them. Assigned (admin) proxies are checkable but not editable.
 */
export async function checkManagerProxyAction(
  id: string,
): Promise<ProxyResult> {
  const session = await requireManager()
  const allowed = await managerCanUseProxy(id, session.sub)
  if (!allowed) return { ok: false, message: 'Прокси недоступен.' }

  const proxy = await getProxyById(id)
  if (!proxy) return { ok: false, message: 'Прокси не найден.' }

  const res = await checkProxy(id)
  revalidatePath('/app/proxies')
  if (!res) {
    return {
      ok: false,
      message: 'Worker недоступен — проверка прокси временно невозможна.',
    }
  }
  // Per-destination breakdown: `telegram` is a real MTProto-DC tunnel check
  // (what GramJS actually needs), `https` is generic web traffic.
  const reachSummary = res.reach
    ? ` Telegram DC: ${res.reach.telegram ? 'OK' : 'нет'}, HTTPS: ${
        res.reach.https ? 'OK' : 'нет'
      }.`
    : ''

  if (res.ok && !res.error) {
    return {
      ok: true,
      message: `Прокси работает (${res.latencyMs ?? '?'} мс).${reachSummary}`,
    }
  }
  if (res.ok && res.error) {
    return { ok: false, message: `${res.error}${reachSummary}` }
  }
  return {
    ok: false,
    message: `${res.error || 'Проверка не пройдена.'}${reachSummary}`,
  }
}
