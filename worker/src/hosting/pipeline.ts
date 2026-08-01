import { randomBytes } from 'node:crypto'
import { logger } from '../logger.js'
import * as repo from './repo.js'
import {
  connect,
  disconnect,
  execCollect,
  execStream,
  type SshConnection,
} from './ssh.js'

/**
 * The real deploy pipeline: connect to the server over SSH, clone/pull the repo,
 * install + build per runtime, (re)start the process under pm2 or Docker, and
 * wire up a Caddy reverse proxy with automatic HTTPS when a domain is set. Every
 * command's output is streamed line-by-line into hosting_deploy_logs so the
 * panel can tail it live.
 *
 * Runs ONLY inside the worker (never a serverless function). Requires the target
 * server to have: git, node+npm (node runtime), docker (docker runtime), and
 * optionally caddy (reverse proxy). Missing tooling surfaces as a failed step
 * with a clear log line rather than a silent hang.
 */

/** Root directory on the server where app checkouts live. */
const APPS_ROOT = '/opt/omnidesk-apps'

/** POSIX single-quote escaping so a value can't break out of the shell. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export async function runDeploy(job: repo.DeployJob): Promise<void> {
  const { app_id: appId, deployment_id: deploymentId } = job
  if (!appId || !deploymentId) {
    throw new Error('deploy job missing app_id/deployment_id')
  }

  const app = await repo.getApp(appId)
  if (!app) throw new Error('app not found')
  const server = await repo.getServer(app.server_id)
  if (!server) throw new Error('server not found')
  if (!server.secret) throw new Error('server has no SSH credentials')

  const log = (
    stream: 'stdout' | 'stderr' | 'system',
    line: string,
  ): Promise<void> => repo.appendDeployLog(deploymentId, stream, line)

  await repo.setDeploymentStatus(deploymentId, 'cloning', { started: true })
  await repo.setAppStatus(appId, 'building', null)
  await log('system', `Подключение к ${server.ip_address}:${server.ssh_port}…`)

  let conn: SshConnection | null = null
  try {
    conn = await connect({
      host: server.ip_address,
      port: server.ssh_port,
      username: server.ssh_username,
      authType: server.auth_type,
      secret: server.secret,
      pinnedFingerprint: server.host_fingerprint,
    })
    // Pin the host key the first time we ever connect to this server.
    if (!server.host_fingerprint) {
      await repo.pinServerFingerprint(server.id, conn.fingerprint)
      await log('system', `Host key закреплён (${conn.fingerprint.slice(0, 24)}…)`)
    }
    const client = conn.client

    /** Run a shell step: log a header, stream output, throw on non-zero exit. */
    const step = async (title: string, command: string): Promise<void> => {
      await log('system', `$ ${title}`)
      const res = await execStream(client, command, (s, line) => {
        void log(s, line)
      })
      if (res.code !== 0) {
        throw new Error(`${title} — команда завершилась с кодом ${res.code}`)
      }
    }

    const appDir = `${APPS_ROOT}/${app.id}`
    const repoUrl = app.repo_url
    const branch = app.branch || 'main'

    // 1. Clone or fast-forward the repo at the requested branch.
    await repo.setDeploymentStatus(deploymentId, 'cloning')
    await step(
      `git clone/pull ${branch}`,
      `mkdir -p ${sh(APPS_ROOT)} && ` +
        `if [ -d ${sh(appDir)}/.git ]; then ` +
        `cd ${sh(appDir)} && git fetch --all --prune && ` +
        `git checkout ${sh(branch)} && git reset --hard ${sh('origin/' + branch)}; ` +
        `else git clone --branch ${sh(branch)} ${sh(repoUrl)} ${sh(appDir)}; fi`,
    )

    // 2. Record the deployed commit hash.
    const commit = await execCollect(client, `cd ${sh(appDir)} && git rev-parse --short HEAD`)
    const commitHash = commit.stdout.trim() || null
    if (commitHash) {
      await repo.setDeploymentStatus(deploymentId, 'building', { commitHash })
      await log('system', `Коммит: ${commitHash}`)
    }

    // 3. Write the encrypted env vars to a .env file on the server (quoted
    //    heredoc so nothing is shell-expanded), used by the runtime below.
    await writeEnvFile(client, appDir, app.env, log)

    // 4. Build + run per runtime.
    await repo.setDeploymentStatus(deploymentId, 'building')
    await deployByRuntime(client, app, appDir, step, log)

    // 5. Reverse proxy + HTTPS via Caddy when a domain is configured.
    if (app.domain && app.port) {
      await configureCaddy(client, app.domain, app.port, step, log).catch(
        async (err) => {
          // A proxy failure shouldn't fail the whole deploy — the app is up on
          // its port; surface a warning the operator can act on.
          await log(
            'stderr',
            `Не удалось настроить reverse-proxy: ${err instanceof Error ? err.message : String(err)}`,
          )
        },
      )
    }

    await repo.setDeploymentStatus(deploymentId, 'success', { finished: true })
    await repo.setAppStatus(appId, 'running', null)
    await log('system', 'Деплой завершён успешно.')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.error({ err: msg, appId }, 'deploy failed')
    await log('stderr', `Ошибка деплоя: ${msg}`)
    await repo.setDeploymentStatus(deploymentId, 'failed', { finished: true })
    await repo.setAppStatus(appId, 'error', msg)
    throw err
  } finally {
    if (conn) disconnect(conn.client)
  }
}

/** Upload the app's env map as a .env file using a random quoted heredoc. */
async function writeEnvFile(
  client: SshConnection['client'],
  appDir: string,
  env: Record<string, string>,
  log: (s: 'stdout' | 'stderr' | 'system', line: string) => Promise<void>,
): Promise<void> {
  const keys = Object.keys(env)
  if (keys.length === 0) {
    await execCollect(client, `rm -f ${sh(appDir)}/.env`)
    return
  }
  const body = keys.map((k) => `${k}=${env[k]}`).join('\n')
  const delim = `OMNIDESK_ENV_${randomBytes(8).toString('hex')}`
  // Quoted heredoc delimiter => no variable expansion inside the body.
  const cmd = `cat > ${sh(appDir)}/.env <<'${delim}'\n${body}\n${delim}\n` +
    `chmod 600 ${sh(appDir)}/.env`
  const res = await execCollect(client, cmd)
  if (res.code !== 0) throw new Error('не удалось записать .env')
  await log('system', `Записано ${keys.length} переменных окружения (.env, chmod 600).`)
}

/** Dispatch build+run by declared runtime. */
async function deployByRuntime(
  client: SshConnection['client'],
  app: repo.AppRecord,
  appDir: string,
  step: (title: string, command: string) => Promise<void>,
  log: (s: 'stdout' | 'stderr' | 'system', line: string) => Promise<void>,
): Promise<void> {
  const name = `omnidesk-${app.id}`
  switch (app.runtime) {
    case 'node': {
      await step(
        'npm install',
        `cd ${sh(appDir)} && (npm ci || npm install)`,
      )
      // Build only when a build script exists.
      await step(
        'npm run build (если есть)',
        `cd ${sh(appDir)} && ` +
          `if npm run | grep -q '^  build'; then npm run build; else echo "нет build-скрипта, пропускаю"; fi`,
      )
      // Start (or reload) under pm2 via a wrapper that loads .env.
      const port = app.port ?? 3000
      const wrapper =
        `set -a; [ -f ./.env ] && . ./.env; set +a; ` +
        `export PORT=${port}; exec npm start`
      await step(
        'запуск через pm2',
        `cd ${sh(appDir)} && ` +
          `command -v pm2 >/dev/null 2>&1 || npm install -g pm2; ` +
          `printf '%s' ${sh(wrapper)} > ./omnidesk-start.sh && chmod +x ./omnidesk-start.sh; ` +
          `pm2 delete ${sh(name)} >/dev/null 2>&1 || true; ` +
          `pm2 start ./omnidesk-start.sh --name ${sh(name)} && pm2 save`,
      )
      return
    }
    case 'docker': {
      const port = app.port ?? 3000
      await step(
        'docker build',
        `cd ${sh(appDir)} && docker build -t ${sh(name)} .`,
      )
      await step(
        'docker run',
        `docker rm -f ${sh(name)} >/dev/null 2>&1 || true; ` +
          `docker run -d --name ${sh(name)} --restart unless-stopped ` +
          `--env-file ${sh(appDir)}/.env -p ${port}:${port} ${sh(name)}`,
      )
      return
    }
    case 'static': {
      // Build if it's a node-based static site, then let Caddy serve the dir.
      await step(
        'сборка статики (если есть)',
        `cd ${sh(appDir)} && ` +
          `if [ -f package.json ]; then (npm ci || npm install) && ` +
          `(npm run | grep -q '^  build' && npm run build || echo "нет build"); ` +
          `else echo "статические файлы, сборка не требуется"; fi`,
      )
      await log('system', 'Статический сайт будет обслуживаться reverse-proxy (Caddy).')
      return
    }
    case 'php': {
      const port = app.port ?? 8080
      const wrapper = `exec php -S 0.0.0.0:${port} -t ${appDir}`
      await step(
        'запуск PHP через pm2',
        `cd ${sh(appDir)} && ` +
          `command -v pm2 >/dev/null 2>&1 || npm install -g pm2; ` +
          `printf '%s' ${sh(wrapper)} > ./omnidesk-start.sh && chmod +x ./omnidesk-start.sh; ` +
          `pm2 delete ${sh(name)} >/dev/null 2>&1 || true; ` +
          `pm2 start ./omnidesk-start.sh --name ${sh(name)} && pm2 save`,
      )
      return
    }
    default:
      throw new Error(`неизвестный рантайм: ${app.runtime as string}`)
  }
}

/**
 * Write a per-app Caddy site file and reload Caddy. Caddy auto-provisions a
 * Let's Encrypt certificate for the domain, so this also gives HTTPS. Requires
 * caddy installed with an import of /etc/caddy/omnidesk/*.caddy in the main
 * Caddyfile (documented for the operator).
 */
async function configureCaddy(
  client: SshConnection['client'],
  domain: string,
  port: number,
  step: (title: string, command: string) => Promise<void>,
  log: (s: 'stdout' | 'stderr' | 'system', line: string) => Promise<void>,
): Promise<void> {
  const site = `${domain} {\n\treverse_proxy 127.0.0.1:${port}\n}\n`
  const path = `/etc/caddy/omnidesk/${domain}.caddy`
  await step(
    'настройка reverse-proxy (Caddy)',
    `command -v caddy >/dev/null 2>&1 || { echo "caddy не установлен"; exit 1; }; ` +
      `mkdir -p /etc/caddy/omnidesk && ` +
      `printf '%s' ${sh(site)} > ${sh(path)} && ` +
      `(caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || systemctl reload caddy)`,
  )
  await log('system', `Домен ${domain} → 127.0.0.1:${port} (HTTPS через Caddy).`)
}
