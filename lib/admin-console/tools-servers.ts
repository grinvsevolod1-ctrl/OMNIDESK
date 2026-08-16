import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createDeployment,
  enqueueDeployJob,
  getAppById,
  getServerById,
  listAppsForServer,
  listDeploymentsForApp,
  listServers,
} from '@/lib/data/hosting'
import type { RunState } from './run-state'

/** Shared with the local-command layer so labels can never drift apart. */
export const SERVER_STATUS_RU: Record<string, string> = {
  online: 'в сети',
  offline: 'не в сети',
  unknown: 'не проверялся',
}

const APP_STATUS_RU: Record<string, string> = {
  running: 'работает',
  stopped: 'остановлено',
  building: 'сборка',
  error: 'ошибка',
}

/**
 * Read + deploy tools for the hosting fleet (/admin/servers). Deploys go
 * through the confirmation modal; SSH secrets and env VALUES never reach the
 * model — only names, statuses and metrics.
 */
export function serverTools(state: RunState) {
  return {
    list_servers: tool({
      description:
        'Список серверов хостинга: статус (в сети/ошибка), IP, метрики (CPU/RAM/диск/аптайм), число приложений. Отвечает на «покажи серверы», «что с серверами», «какие серверы упали».',
      inputSchema: z.object({}),
      execute: async () => {
        const servers = await listServers()
        state.views.push({
          kind: 'servers',
          title: 'Серверы',
          payload: servers.map((s) => ({
            id: s.id,
            name: s.name,
            ip: s.ipAddress,
            status: s.status,
            statusLabel: SERVER_STATUS_RU[s.status] ?? s.status,
            cpu: s.metrics?.cpu ?? null,
            memory: s.metrics?.mem ?? null,
            disk: s.metrics?.disk ?? null,
            uptime: s.metrics?.uptime ?? null,
            apps: s.appCount ?? 0,
            lastError: s.lastError,
          })),
        })
        return {
          total: servers.length,
          online: servers.filter((s) => s.status === 'online').length,
          problems: servers
            .filter((s) => s.status === 'offline' || s.lastError)
            .map((s) => ({ id: s.id, name: s.name, error: s.lastError })),
        }
      },
    }),

    show_server_apps: tool({
      description:
        'Приложения на сервере: статус, домен, ветка, автодеплой, последние деплои. serverId бери из list_servers. Отвечает на «что крутится на сервере X», «какие приложения задеплоены».',
      inputSchema: z.object({ serverId: z.string().min(1) }),
      execute: async ({ serverId }) => {
        const server = await getServerById(serverId)
        if (!server) return { ok: false, message: 'Сервер не найден' }
        const apps = await listAppsForServer(serverId)
        // Parallel: one sequential round-trip per app would be a classic N+1.
        const rows = await Promise.all(
          apps.map(async (app) => {
            const deploys = await listDeploymentsForApp(app.id, 1)
            const last = deploys[0]
            return {
              id: app.id,
              name: app.name,
              status: app.status,
              statusLabel: APP_STATUS_RU[app.status] ?? app.status,
              domain: app.domain,
              branch: app.branch,
              autoDeploy: app.autoDeploy,
              lastDeployStatus: last?.status ?? null,
              lastDeployAt: last?.finishedAt ?? last?.startedAt ?? null,
              lastError: app.lastError,
            }
          }),
        )
        state.views.push({
          kind: 'apps',
          title: `Приложения — ${server.name}`,
          payload: rows,
        })
        return { server: server.name, apps: rows.length }
      },
    }),

    deploy_app: tool({
      description:
        'Запустить деплой приложения (git pull + build + restart). appId бери из show_server_apps. ОПАСНО: не запускается сразу — вернёт needsConfirmation, попроси админа подтвердить.',
      inputSchema: z.object({ appId: z.string().min(1) }),
      execute: async ({ appId }) => {
        const app = await getAppById(appId)
        if (!app) return { ok: false, message: 'Приложение не найдено' }
        if (app.status === 'building')
          return { ok: false, message: `«${app.name}» уже собирается` }
        state.pending = {
          kind: 'deploy_app',
          label: `Деплой → ${app.name}`,
          detail: `Ветка ${app.branch}${app.domain ? `, домен ${app.domain}` : ''}. Приложение будет пересобрано и перезапущено.`,
          payload: { id: appId },
        }
        return { ok: true, needsConfirmation: true, app: app.name }
      },
    }),
  }
}

/**
 * Executed from the confirmation action after the admin approves. Mirrors
 * the classic manual-deploy flow in app/actions/hosting.ts exactly
 * (deployment row + queued worker job).
 */
export async function executeDeployApp(
  appId: string,
): Promise<{ ok: boolean; message: string }> {
  const app = await getAppById(appId)
  if (!app) return { ok: false, message: 'Приложение не найдено' }
  if (app.status === 'building')
    return { ok: false, message: `«${app.name}» уже собирается` }
  const deployment = await createDeployment(appId, 'copilot')
  await enqueueDeployJob({
    action: 'deploy',
    serverId: app.serverId,
    appId,
    deploymentId: deployment.id,
  })
  return {
    ok: true,
    message: `Деплой «${app.name}» запущен — логи в разделе серверов`,
  }
}
