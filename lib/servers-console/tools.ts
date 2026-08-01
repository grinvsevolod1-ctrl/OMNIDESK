import 'server-only'
import { tool } from 'ai'
import { z } from 'zod'
import {
  createApp,
  createDeployment,
  deleteApp,
  deleteServer,
  enqueueDeployJob,
  getAppById,
  getServerById,
  listAppsForServer,
  listDeploymentsForApp,
  listServers,
} from '@/lib/data/hosting'
import { appNameFromRepo, type RunState } from './run-state'

/**
 * Tools for the conversational servers assistant. Read tools (list_servers,
 * get_server, list_deployments) GROUND the model in real fleet state; action
 * tools onboard servers, create apps and launch the autonomous deploy agent.
 *
 * SECURITY: no tool ever accepts an SSH secret or repo token as an argument —
 * request_server_credentials only opens a secure client-side form. Secrets are
 * submitted straight to a server action, never through the model.
 */
export function serversTools(state: RunState) {
  return {
    list_servers: tool({
      description:
        'Показать все подключённые серверы с их состоянием и числом приложений. Вызывай, прежде чем ссылаться на конкретный сервер или предлагать, куда деплоить.',
      inputSchema: z.object({}),
      execute: async () => {
        const servers = await listServers()
        return {
          count: servers.length,
          servers: servers.map((s) => ({
            id: s.id,
            name: s.name,
            ip: s.ipAddress,
            status: s.status,
            appCount: s.appCount ?? 0,
            hasSecret: s.hasSecret,
            cpu: s.metrics.cpu,
            mem: s.metrics.mem,
            disk: s.metrics.disk,
          })),
        }
      },
    }),

    get_server: tool({
      description:
        'Показать детали одного сервера: метрики (CPU/RAM/диск), состояние и его приложения. Сначала возьми id через list_servers.',
      inputSchema: z.object({ serverId: z.string().min(1) }),
      execute: async ({ serverId }) => {
        const server = await getServerById(serverId)
        if (!server) return { ok: false, reason: 'server_not_found' }
        const apps = await listAppsForServer(serverId)
        return {
          ok: true,
          server: {
            id: server.id,
            name: server.name,
            ip: server.ipAddress,
            status: server.status,
            hasSecret: server.hasSecret,
            metrics: server.metrics,
            lastError: server.lastError,
          },
          apps: apps.map((a) => ({
            id: a.id,
            name: a.name,
            repoUrl: a.repoUrl,
            domain: a.domain,
            status: a.status,
            runtime: a.runtime,
          })),
        }
      },
    }),

    list_deployments: tool({
      description:
        'Показать последние деплои приложения (статус, режим manual/ai, краткое резюме). Сначала возьми appId через get_server.',
      inputSchema: z.object({ appId: z.string().min(1) }),
      execute: async ({ appId }) => {
        const deployments = await listDeploymentsForApp(appId, 10)
        return {
          count: deployments.length,
          deployments: deployments.map((d) => ({
            id: d.id,
            status: d.status,
            mode: d.mode,
            summary: d.summary,
            siteUrl: d.siteUrl,
            createdAt: d.createdAt,
          })),
        }
      },
    }),

    request_server_credentials: tool({
      description:
        'Открыть админу ЗАЩИЩЁННУЮ форму для ввода секрета, который тебе видеть нельзя. kind="server" — подключение нового сервера (SSH-ключ или пароль); передай собранные НЕсекретные поля (name, ipAddress, sshPort, sshUsername, authType). kind="repo_token" — GitHub-токен для приватного репозитория; передай appId и/или repoUrl. НИКОГДА не проси сам секрет в чате — только через эту форму.',
      inputSchema: z.object({
        kind: z.enum(['server', 'repo_token']),
        name: z.string().max(120).optional(),
        ipAddress: z.string().max(120).optional(),
        sshPort: z.number().int().min(1).max(65535).optional(),
        sshUsername: z.string().max(120).optional(),
        authType: z.enum(['ssh_key', 'password']).optional(),
        appId: z.string().max(120).optional(),
        repoUrl: z.string().max(400).optional(),
      }),
      execute: async (input) => {
        state.credentialRequest = {
          kind: input.kind,
          name: input.name,
          ipAddress: input.ipAddress,
          sshPort: input.sshPort ?? 22,
          sshUsername: input.sshUsername ?? 'root',
          authType: input.authType ?? 'ssh_key',
          appId: input.appId,
          repoUrl: input.repoUrl,
          note:
            input.kind === 'server'
              ? 'Секрет вводится напрямую в форму и не проходит через ИИ.'
              : 'Токен вводится напрямую в форму и не проходит через ИИ.',
        }
        return { ok: true, formOpened: true }
      },
    }),

    start_ai_deploy: tool({
      description:
        'Запустить АВТОНОМНУЮ ИИ-установку проекта на сервере: агент сам зайдёт по SSH, проанализирует сервер, поставит всё необходимое, склонирует репозиторий, соберёт и запустит проект, настроит домен и SSL. Укажи serverId (возьми через list_servers) и repoUrl. domain, branch, name — по желанию. Если приложение уже есть — передай appId вместо repoUrl. Вернёт deploymentId для живого лога.',
      inputSchema: z.object({
        serverId: z.string().min(1),
        appId: z.string().optional(),
        repoUrl: z.string().max(400).optional(),
        domain: z.string().max(200).optional(),
        branch: z.string().max(120).optional(),
        name: z.string().max(120).optional(),
        runtime: z.enum(['node', 'docker', 'static', 'php']).optional(),
      }),
      execute: async (input) => {
        const server = await getServerById(input.serverId)
        if (!server) return { ok: false, reason: 'server_not_found' }
        if (!server.hasSecret) {
          // Can't deploy without SSH credentials — nudge the model to onboard.
          return { ok: false, reason: 'server_has_no_credentials' }
        }

        // Resolve (or create) the app to deploy.
        let app = input.appId ? await getAppById(input.appId) : null
        if (!app) {
          if (!input.repoUrl) return { ok: false, reason: 'repo_url_required' }
          app = await createApp({
            serverId: server.id,
            name: input.name?.trim() || appNameFromRepo(input.repoUrl),
            repoUrl: input.repoUrl.trim(),
            branch: input.branch?.trim() || 'main',
            domain: input.domain?.trim() || null,
            runtime: input.runtime ?? 'node',
          })
          state.actions.push({
            kind: 'app_created',
            label: `Создал приложение ${app.name}`,
          })
        }

        const deployment = await createDeployment(app.id, 'ai-console', 'ai')
        await enqueueDeployJob({
          action: 'ai_deploy',
          serverId: server.id,
          appId: app.id,
          deploymentId: deployment.id,
          payload: {
            domain: input.domain?.trim() || app.domain || null,
          },
        })

        state.launchedDeploy = {
          deploymentId: deployment.id,
          appId: app.id,
          appName: app.name,
          serverName: server.name,
          repoUrl: app.repoUrl,
          domain: input.domain?.trim() || app.domain || null,
        }
        state.actions.push({
          kind: 'deploy_started',
          label: `Запустил ИИ-установку ${app.name} на ${server.name}`,
        })
        state.dataChanged = true
        return {
          ok: true,
          deploymentId: deployment.id,
          appId: app.id,
          appName: app.name,
        }
      },
    }),

    manage_app: tool({
      description:
        'Управлять жизненным циклом приложения на сервере: action="start" (запустить), "stop" (остановить), "restart" (перезапустить). Возьми appId через get_server. Для повторной установки используй start_ai_deploy с этим appId, а не manage_app.',
      inputSchema: z.object({
        appId: z.string().min(1),
        action: z.enum(['start', 'stop', 'restart']),
      }),
      execute: async ({ appId, action }) => {
        const app = await getAppById(appId)
        if (!app) return { ok: false, reason: 'app_not_found' }
        await enqueueDeployJob({ action, serverId: app.serverId, appId })
        const verb =
          action === 'start' ? 'Запускаю' : action === 'stop' ? 'Останавливаю' : 'Перезапускаю'
        state.actions.push({ kind: 'lifecycle', label: `${verb} ${app.name}` })
        state.dataChanged = true
        return { ok: true, appId, action }
      },
    }),

    delete_app: tool({
      description:
        'Удалить приложение: остановить процесс, удалить его код с сервера и убрать запись. НЕОБРАТИМО — сначала явно подтверди у админа и вызывай только с confirm=true. Возьми appId через get_server.',
      inputSchema: z.object({
        appId: z.string().min(1),
        confirm: z
          .boolean()
          .describe('Должно быть true — подтверждение админа на удаление.'),
      }),
      execute: async ({ appId, confirm }) => {
        if (!confirm) return { ok: false, reason: 'confirmation_required' }
        const app = await getAppById(appId)
        if (!app) return { ok: false, reason: 'app_not_found' }
        const server = await getServerById(app.serverId)
        // Reachable server → worker stops the process, cleans the code and drops
        // the row atomically. Otherwise just remove the record.
        if (server?.hasSecret) {
          await enqueueDeployJob({ action: 'remove', serverId: app.serverId, appId })
        } else {
          await deleteApp(appId)
        }
        state.actions.push({ kind: 'app_deleted', label: `Удаляю приложение ${app.name}` })
        state.dataChanged = true
        return {
          ok: true,
          appId,
          cleanedRemotely: Boolean(server?.hasSecret),
        }
      },
    }),

    delete_server: tool({
      description:
        'Отключить сервер из панели и удалить его запись (вместе с его приложениями в базе). НЕОБРАТИМО и НЕ останавливает процессы на самом сервере — сначала явно подтверди у админа и вызывай только с confirm=true. Возьми serverId через list_servers.',
      inputSchema: z.object({
        serverId: z.string().min(1),
        confirm: z
          .boolean()
          .describe('Должно быть true — подтверждение админа на удаление.'),
      }),
      execute: async ({ serverId, confirm }) => {
        if (!confirm) return { ok: false, reason: 'confirmation_required' }
        const server = await getServerById(serverId)
        if (!server) return { ok: false, reason: 'server_not_found' }
        const apps = await listAppsForServer(serverId)
        const ok = await deleteServer(serverId)
        if (!ok) return { ok: false, reason: 'delete_failed' }
        state.actions.push({
          kind: 'server_deleted',
          label: `Отключил сервер ${server.name}`,
        })
        state.dataChanged = true
        return { ok: true, serverId, hadApps: apps.length }
      },
    }),

    open_panel: tool({
      description:
        'Открыть рабочую панель инлайн под сообщением: kind="servers" — список серверов; kind="server" с id — детали сервера; kind="app" с id — детали приложения (управление, env, история деплоев, логи). Вызывай, когда админ просит «покажи/открой» или задачу удобнее закончить руками.',
      inputSchema: z.object({
        kind: z.enum(['servers', 'server', 'app']),
        id: z.string().optional(),
      }),
      execute: async ({ kind, id }) => {
        if (kind === 'servers') {
          state.openPanel = { kind: 'servers' }
        } else if (kind === 'server') {
          if (!id) return { ok: false, reason: 'id_required' }
          state.openPanel = { kind: 'server', id }
        } else {
          if (!id) return { ok: false, reason: 'id_required' }
          const app = await getAppById(id)
          if (!app) return { ok: false, reason: 'app_not_found' }
          state.openPanel = { kind: 'app', id, serverId: app.serverId }
        }
        return { ok: true, kind, id }
      },
    }),
  }
}
