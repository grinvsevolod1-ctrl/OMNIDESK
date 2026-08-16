'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  cancelDeployment,
  createServer,
  enqueueDeployJob,
  getAppById,
  getDeploymentById,
  listServers,
  setAppRepoToken,
} from '@/lib/data'
import {
  SERVER_AUTH_TYPES,
  isValidHost,
  isValidPort,
} from '@/lib/hosting/validate'
import type {
  AssistantResult,
  AssistantTurn,
} from '@/lib/servers-console/assistant'
import { runAssistantOnce } from '@/lib/servers-console/run-assistant'
import type { HostingServer, ServerAuthType } from '@/lib/types'

/**
 * Server actions dedicated to the conversational "Серверы" console. Secrets
 * (SSH key/password, GitHub token) are submitted straight here from the secure
 * client-side CredentialCard — they NEVER travel through the LLM. Everything is
 * admin-gated and the secret is encrypted at rest by the data layer.
 */

export interface ConsoleActionResult {
  ok: boolean
  message: string
}

/** Re-read the fleet so the console can refresh its list after a mutation. */
export async function refreshServersAction(): Promise<HostingServer[]> {
  await requireAdmin()
  return listServers()
}

/**
 * One-shot (non-streaming) assistant turn — the client's fallback when the SSE
 * stream fails, so the console never dead-ends. Mirrors the AI-manager console's
 * aiAssistantAction.
 */
export async function serversAssistantAction(
  history: AssistantTurn[],
): Promise<AssistantResult> {
  await requireAdmin()
  return runAssistantOnce(history)
}

/**
 * Onboard a new server from the console's secure credential form. Mirrors
 * createServerAction but returns the new server id so the console can offer to
 * deploy to it immediately, and kicks off a health check.
 */
export async function saveServerCredentialsAction(
  formData: FormData,
): Promise<ConsoleActionResult & { serverId?: string }> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const ipAddress = String(formData.get('ipAddress') ?? '').trim()
  const sshPort = Number(String(formData.get('sshPort') ?? '22').trim())
  const authType = String(
    formData.get('authType') ?? 'ssh_key',
  ) as ServerAuthType
  const sshUsername = String(formData.get('sshUsername') ?? 'root').trim()
  const secret = String(formData.get('secret') ?? '').trim() || null

  if (!name) return { ok: false, message: 'Укажите название сервера.' }
  if (!isValidHost(ipAddress)) {
    return { ok: false, message: 'Введите корректный IP-адрес или хост.' }
  }
  if (!isValidPort(sshPort)) {
    return { ok: false, message: 'Введите корректный SSH-порт (1–65535).' }
  }
  if (!SERVER_AUTH_TYPES.includes(authType)) {
    return { ok: false, message: 'Неизвестный тип авторизации.' }
  }
  if (!sshUsername) return { ok: false, message: 'Укажите SSH-пользователя.' }
  if (!secret) {
    return {
      ok: false,
      message:
        authType === 'ssh_key'
          ? 'Вставьте приватный SSH-ключ.'
          : 'Введите пароль для SSH.',
    }
  }

  const server = await createServer({
    name,
    ipAddress,
    sshPort,
    authType,
    sshUsername,
    secret,
  })
  await enqueueDeployJob({ action: 'health_check', serverId: server.id })
  revalidatePath('/admin/servers')
  return {
    ok: true,
    serverId: server.id,
    message: `Сервер «${server.name}» подключён. Учётные данные зашифрованы, идёт проверка связи.`,
  }
}

/**
 * Store the GitHub token for an app's private repo, submitted from the secure
 * form. The token is encrypted at rest and used by the deploy agent to clone
 * over HTTPS. Never logged or returned.
 */
export async function saveRepoTokenAction(
  appId: string,
  token: string,
): Promise<ConsoleActionResult> {
  await requireAdmin()
  const app = await getAppById(appId)
  if (!app) return { ok: false, message: 'Приложение не найдено.' }
  const trimmed = token.trim()
  if (!trimmed) return { ok: false, message: 'Введите токен доступа.' }
  await setAppRepoToken(appId, trimmed)
  revalidatePath('/admin/servers')
  return {
    ok: true,
    message: 'Токен сохранён и зашифрован. Можно запускать установку.',
  }
}

/**
 * Cancel a running autonomous deploy. Marks the deployment failed; the agent
 * polls the status between steps and aborts gracefully.
 */
export async function cancelAiDeployAction(
  deploymentId: string,
): Promise<ConsoleActionResult> {
  await requireAdmin()
  const dep = await getDeploymentById(deploymentId)
  if (!dep) return { ok: false, message: 'Деплой не найден.' }
  const ok = await cancelDeployment(deploymentId)
  revalidatePath('/admin/servers')
  return ok
    ? { ok: true, message: 'Отмена запрошена — агент остановится на ближайшем шаге.' }
    : { ok: false, message: 'Этот деплой уже завершён.' }
}
