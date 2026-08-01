'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import {
  createApp,
  createDeployment,
  createServer,
  deleteApp,
  deleteServer,
  enqueueDeployJob,
  getAppById,
  getServerById,
  updateAppEnv,
} from '@/lib/data'
import {
  APP_RUNTIMES,
  SERVER_AUTH_TYPES,
  isValidDomain,
  isValidHost,
  isValidPort,
  isValidRepoUrl,
  parseEnvText,
} from '@/lib/hosting/validate'
import type { AppRuntime, DeployAction, ServerAuthType } from '@/lib/types'

export interface HostingResult {
  ok: boolean
  message: string
}

/* ------------------------------- Servers ------------------------------- */

/** Admin: register a new managed server. SSH secret is encrypted at rest. */
export async function createServerAction(
  formData: FormData,
): Promise<HostingResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const ipAddress = String(formData.get('ipAddress') ?? '').trim()
  const sshPort = Number(String(formData.get('sshPort') ?? '22').trim())
  const authType = String(formData.get('authType') ?? 'ssh_key') as ServerAuthType
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
  // Kick off an immediate health check so status/metrics populate.
  await enqueueDeployJob({ action: 'health_check', serverId: server.id })
  revalidatePath('/admin/servers')
  return {
    ok: true,
    message: 'Сервер добавлен. Учётные данные зашифрованы, идёт проверка связи.',
  }
}

/** Admin: enqueue a connectivity/health check for a server. */
export async function testServerAction(id: string): Promise<HostingResult> {
  await requireAdmin()
  const server = await getServerById(id)
  if (!server) return { ok: false, message: 'Сервер не найден.' }
  await enqueueDeployJob({ action: 'health_check', serverId: id })
  revalidatePath('/admin/servers')
  revalidatePath(`/admin/servers/${id}`)
  return { ok: true, message: 'Проверка связи запущена.' }
}

export async function deleteServerAction(id: string): Promise<HostingResult> {
  await requireAdmin()
  const ok = await deleteServer(id)
  revalidatePath('/admin/servers')
  return ok
    ? { ok: true, message: 'Сервер и его приложения удалены.' }
    : { ok: false, message: 'Сервер не найден.' }
}

/* -------------------------------- Apps --------------------------------- */

/** Admin: create an app on a server from a Git repo. */
export async function createAppAction(
  serverId: string,
  formData: FormData,
): Promise<HostingResult> {
  await requireAdmin()
  const server = await getServerById(serverId)
  if (!server) return { ok: false, message: 'Сервер не найден.' }

  const name = String(formData.get('name') ?? '').trim()
  const repoUrl = String(formData.get('repoUrl') ?? '').trim()
  const branch = String(formData.get('branch') ?? 'main').trim() || 'main'
  const domain = String(formData.get('domain') ?? '').trim() || null
  const runtime = String(formData.get('runtime') ?? 'node') as AppRuntime
  const portRaw = String(formData.get('port') ?? '').trim()
  const port = portRaw ? Number(portRaw) : null

  if (!name) return { ok: false, message: 'Укажите название приложения.' }
  if (!isValidRepoUrl(repoUrl)) {
    return { ok: false, message: 'Введите корректный URL Git-репозитория.' }
  }
  if (!APP_RUNTIMES.includes(runtime)) {
    return { ok: false, message: 'Неизвестный рантайм.' }
  }
  if (domain && !isValidDomain(domain)) {
    return { ok: false, message: 'Введите корректный домен (например, app.example.com).' }
  }
  if (port !== null && !isValidPort(port)) {
    return { ok: false, message: 'Введите корректный порт приложения (1–65535).' }
  }

  const app = await createApp({
    serverId,
    name,
    repoUrl,
    branch,
    domain,
    runtime,
    port,
  })
  revalidatePath(`/admin/servers/${serverId}`)
  return {
    ok: true,
    message: `Приложение «${app.name}» создано. Запустите деплой, когда будете готовы.`,
  }
}

/** Admin: replace an app's environment variables (encrypted at rest). */
export async function updateAppEnvAction(
  appId: string,
  envText: string,
): Promise<HostingResult> {
  await requireAdmin()
  const app = await getAppById(appId)
  if (!app) return { ok: false, message: 'Приложение не найдено.' }

  const parsed = parseEnvText(envText)
  if (!parsed.ok) return { ok: false, message: parsed.error }

  await updateAppEnv(appId, parsed.env)
  revalidatePath(`/admin/servers/${app.serverId}/apps/${appId}`)
  const n = Object.keys(parsed.env).length
  return {
    ok: true,
    message: `Сохранено ${n} переменных окружения. Изменения применятся при следующем деплое.`,
  }
}

export async function deleteAppAction(appId: string): Promise<HostingResult> {
  await requireAdmin()
  const app = await getAppById(appId)
  if (!app) return { ok: false, message: 'Приложение не найдено.' }
  const server = await getServerById(app.serverId)
  // If we can reach the server, let the worker stop the process, clean the code
  // AND delete the row (atomic cleanup — see runLifecycle 'remove'). Deleting
  // the row here first would make the worker's remove job miss the app and leave
  // the process running on the server.
  if (server?.hasSecret) {
    await enqueueDeployJob({ action: 'remove', serverId: app.serverId, appId })
    revalidatePath(`/admin/servers/${app.serverId}`)
    return { ok: true, message: 'Приложение останавливается и удаляется с сервера.' }
  }
  // No SSH credentials to reach the server — just drop the record; the remote
  // process (if any) can't be cleaned automatically.
  await deleteApp(appId)
  revalidatePath(`/admin/servers/${app.serverId}`)
  return {
    ok: true,
    message: 'Приложение удалено из панели. Доступа к серверу нет — процесс на сервере мог остаться.',
  }
}

/* ------------------------- Lifecycle / deploys ------------------------- */

/**
 * Admin: trigger a deploy. Creates a deployment row (so logs have a parent) and
 * enqueues the deploy job; the worker clones, builds and starts the app over
 * SSH, streaming logs into hosting_deploy_logs. Returns the deployment id so the
 * UI can open the live log stream.
 */
export async function deployAction(
  appId: string,
): Promise<HostingResult & { deploymentId?: string }> {
  await requireAdmin()
  const app = await getAppById(appId)
  if (!app) return { ok: false, message: 'Приложение не найдено.' }

  const deployment = await createDeployment(appId, 'manual')
  await enqueueDeployJob({
    action: 'deploy',
    serverId: app.serverId,
    appId,
    deploymentId: deployment.id,
  })
  revalidatePath(`/admin/servers/${app.serverId}/apps/${appId}`)
  return {
    ok: true,
    message: 'Деплой запущен. Логи появятся ниже в реальном времени.',
    deploymentId: deployment.id,
  }
}

/** Admin: start/stop/restart a deployed app via the worker. */
export async function lifecycleAction(
  appId: string,
  action: Extract<DeployAction, 'start' | 'stop' | 'restart'>,
): Promise<HostingResult> {
  await requireAdmin()
  const app = await getAppById(appId)
  if (!app) return { ok: false, message: 'Приложение не найдено.' }
  if (action !== 'start' && action !== 'stop' && action !== 'restart') {
    return { ok: false, message: 'Недопустимое действие.' }
  }
  await enqueueDeployJob({
    action,
    serverId: app.serverId,
    appId,
  })
  revalidatePath(`/admin/servers/${app.serverId}/apps/${appId}`)
  const label =
    action === 'start' ? 'Запуск' : action === 'stop' ? 'Остановка' : 'Перезапуск'
  return { ok: true, message: `${label} приложения запрошен.` }
}
