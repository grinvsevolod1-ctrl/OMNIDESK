import { query } from '../db.js'
import { logger } from '../logger.js'
import * as repo from './repo.js'
import { connect, disconnect, execCollect, type SshConnection } from './ssh.js'

/**
 * Server health checks and app lifecycle commands (start/stop/restart/remove).
 * All run over SSH from the worker. Health metrics are best-effort: any single
 * probe that fails degrades to null rather than failing the whole check.
 */

/** Single shell snippet that prints cpu/mem/disk/uptime in a parseable form. */
const METRICS_CMD = [
  // CPU %: 100 - idle from top; falls back to empty on parse failure.
  `cpu=$(top -bn1 2>/dev/null | awk -F',' '/Cpu\\(s\\)/{for(i=1;i<=NF;i++) if($i ~ /id/){gsub(/[^0-9.]/,"",$i); printf "%.0f", 100-$i}}')`,
  // Memory used %.
  `mem=$(free 2>/dev/null | awk '/Mem:/{printf "%.0f", $3/$2*100}')`,
  // Root filesystem used %.
  `disk=$(df -P / 2>/dev/null | awk 'NR==2{gsub("%","",$5); print $5}')`,
  // Human uptime.
  `up=$(uptime -p 2>/dev/null || uptime 2>/dev/null)`,
  `echo "cpu=$cpu;mem=$mem;disk=$disk;uptime=$up"`,
].join('; ')

interface ParsedMetrics {
  cpu: number | null
  mem: number | null
  disk: number | null
  uptime: string | null
}

/** Parse the METRICS_CMD output line into a metrics object. Exported for tests. */
export function parseMetrics(output: string): ParsedMetrics {
  const line = output
    .split(/\r?\n/)
    .find((l) => l.includes('cpu=') && l.includes('disk='))
  const result: ParsedMetrics = { cpu: null, mem: null, disk: null, uptime: null }
  if (!line) return result
  // uptime may contain ';', so split only the known leading numeric fields.
  const cpuM = /cpu=([0-9.]*)/.exec(line)
  const memM = /mem=([0-9.]*)/.exec(line)
  const diskM = /disk=([0-9.]*)/.exec(line)
  const upM = /uptime=(.*)$/.exec(line)
  const num = (s: string | undefined): number | null => {
    if (!s) return null
    const n = Number(s)
    return Number.isFinite(n) ? n : null
  }
  result.cpu = num(cpuM?.[1])
  result.mem = num(memM?.[1])
  result.disk = num(diskM?.[1])
  const up = upM?.[1]?.trim()
  result.uptime = up ? up : null
  return result
}

/** Connect, collect metrics, and record server health. Never throws. */
export async function runHealthCheck(serverId: string): Promise<void> {
  const server = await repo.getServer(serverId)
  if (!server) return
  if (!server.secret) {
    await repo.setServerHealth(serverId, 'offline', null, 'Нет SSH-доступа (секрет не задан).')
    return
  }
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
    if (!server.host_fingerprint) {
      await repo.pinServerFingerprint(server.id, conn.fingerprint)
    }
    const res = await execCollect(conn.client, METRICS_CMD)
    const metrics = parseMetrics(res.stdout)
    await repo.setServerHealth(
      serverId,
      'online',
      metrics as unknown as Record<string, unknown>,
      null,
    )
    // Piggyback app probes on the already-open SSH session.
    await probeApps(conn, serverId).catch((err) =>
      logger.warn({ err, serverId }, 'app probes failed'),
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    logger.warn({ err: msg, serverId }, 'health check failed')
    await repo.setServerHealth(serverId, 'offline', null, msg)
  } finally {
    if (conn) disconnect(conn.client)
  }
}

/** Consecutive failed probes after which we auto-restart the app (once). */
const RESTART_AFTER_FAILS = 2
/** Consecutive failed probes after which we stop restarting and flag error. */
const FLAG_AFTER_FAILS = 4

/**
 * HTTP-probe every "running" app on the server via the open SSH session.
 * An app that fails RESTART_AFTER_FAILS consecutive probes gets ONE automatic
 * restart; if it keeps failing to FLAG_AFTER_FAILS it is flagged 'error' so
 * the panel/console surfaces it instead of restart-looping forever.
 */
async function probeApps(conn: SshConnection, serverId: string): Promise<void> {
  const apps = await repo.listProbeableApps(serverId)
  for (const app of apps) {
    // -m 10: never hang the sweep; any HTTP response (even 500) proves the
    // process is alive and listening — "unhealthy" here means connection refused
    // or timeout, which curl reports with exit code != 0 and code 000.
    const probe = await execCollect(
      conn.client,
      `curl -s -o /dev/null -m 10 -w '%{http_code}' http://127.0.0.1:${Number(app.port)}/`,
    ).catch(() => null)
    const httpCode = probe?.stdout.trim() ?? '000'
    const healthy = probe !== null && probe.code === 0 && httpCode !== '000'
    const fails = await repo.recordAppHealth(app.id, healthy)
    if (healthy || fails < RESTART_AFTER_FAILS) continue

    if (fails >= FLAG_AFTER_FAILS) {
      await repo.setAppStatus(
        app.id,
        'error',
        `Приложение не отвечает на порту ${app.port} (авто-рестарт не помог).`,
      )
      logger.warn({ appId: app.id, fails }, 'app flagged unhealthy')
      continue
    }
    // One automatic restart attempt (pm2 or docker, matching how it was run).
    logger.warn({ appId: app.id, fails }, 'app unhealthy, auto-restarting')
    const name = `omnidesk-${app.id}`
    const restart =
      app.runtime === 'docker'
        ? `docker restart ${sh(name)}`
        : `pm2 restart ${sh(name)}`
    await execCollect(conn.client, restart).catch(() => null)
  }
}

/** Health-check every server (periodic sweep). */
export async function sweepServerHealth(): Promise<void> {
  const rows = await query<{ id: string }>('SELECT id FROM hosting_servers')
  for (const row of rows) {
    await runHealthCheck(row.id).catch(() => {})
  }
}

/** POSIX single-quote escaping. */
function sh(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Start / stop / restart / remove a deployed app over SSH. Uses pm2 for
 * node/php runtimes and docker for the docker runtime, matching how the deploy
 * pipeline launched them.
 */
export async function runLifecycle(
  action: 'start' | 'stop' | 'restart' | 'remove',
  appId: string,
): Promise<void> {
  const app = await repo.getApp(appId)
  if (!app) throw new Error('app not found')
  const server = await repo.getServer(app.server_id)
  if (!server || !server.secret) throw new Error('server unavailable')

  const name = `omnidesk-${app.id}`
  const isDocker = app.runtime === 'docker'

  let cmd: string
  if (isDocker) {
    switch (action) {
      case 'start':
        cmd = `docker start ${sh(name)}`
        break
      case 'stop':
        cmd = `docker stop ${sh(name)}`
        break
      case 'restart':
        cmd = `docker restart ${sh(name)}`
        break
      case 'remove':
        cmd = `docker rm -f ${sh(name)} >/dev/null 2>&1 || true; ` +
          `rm -rf ${sh(`/opt/omnidesk-apps/${app.id}`)}`
        break
    }
  } else {
    switch (action) {
      case 'start':
        cmd = `pm2 start ${sh(name)} || pm2 restart ${sh(name)}`
        break
      case 'stop':
        cmd = `pm2 stop ${sh(name)}`
        break
      case 'restart':
        cmd = `pm2 restart ${sh(name)}`
        break
      case 'remove':
        cmd = `pm2 delete ${sh(name)} >/dev/null 2>&1 || true; pm2 save; ` +
          `rm -rf ${sh(`/opt/omnidesk-apps/${app.id}`)}`
        break
    }
  }

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
    if (!server.host_fingerprint) {
      await repo.pinServerFingerprint(server.id, conn.fingerprint)
    }
    const res = await execCollect(conn.client, cmd)
    if (res.code !== 0 && action !== 'remove') {
      throw new Error(res.stderr.trim() || `команда завершилась с кодом ${res.code}`)
    }
    // Reflect the new state. For 'remove', the process and code are now gone
    // from the server, so delete the app record too — cleanup is atomic and the
    // console doesn't have to race the worker to drop the row.
    if (action === 'start' || action === 'restart') {
      await repo.setAppStatus(appId, 'running', null)
    } else if (action === 'stop') {
      await repo.setAppStatus(appId, 'stopped', null)
    } else if (action === 'remove') {
      await repo.deleteApp(appId)
    }
  } finally {
    if (conn) disconnect(conn.client)
  }
}
