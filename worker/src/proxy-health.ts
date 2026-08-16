import { logger } from './logger.js'
import * as repo from './repo.js'
import { probeProxy } from './proxy.js'
import { registry } from './registry.js'

/**
 * Periodic proxy health sweep with automatic failover.
 *
 * Every tick, each proxy that currently backs a Telegram channel is probed
 * (real TCP tunnel to a Telegram DC through the proxy — the exact operation
 * GramJS performs). Results land on the proxies row (status, latency_ms,
 * last_checked_at — scripts/108) so the panel always shows fresh health.
 *
 * When a proxy FAILS the probe twice in a row, the sweep looks for the
 * fastest healthy unassigned proxy of the same manager (allocation rule from
 * scripts/040 respected: one proxy = max one Telegram account), atomically
 * repoints the channel at it and restarts the session so GramJS reconnects
 * through the new proxy. If no candidate exists, the proxy is only marked
 * 'error' — the admin sees it in the panel and the session keeps trying
 * through the old one (it may still limp along for established connections).
 *
 * Everything runs locally on the VPS (node:net probes) — no third-party
 * services involved.
 */

/** Consecutive failures per proxy id before failover fires. */
const FAIL_THRESHOLD = 2

const failCounts = new Map<string, number>()

export async function proxyHealthSweep(): Promise<void> {
  let assignments: Array<{
    channelId: string
    proxyId: string
    managerId: string
  }>
  try {
    assignments = await repo.listTelegramProxyAssignments()
  } catch (err) {
    logger.warn({ err }, 'proxy health sweep: listing assignments failed')
    return
  }
  if (assignments.length === 0) return

  // Probe each DISTINCT proxy once even if it backs several channel types.
  const byProxy = new Map<string, typeof assignments>()
  for (const a of assignments) {
    const list = byProxy.get(a.proxyId) ?? []
    list.push(a)
    byProxy.set(a.proxyId, list)
  }

  for (const [proxyId, backed] of byProxy) {
    const config = await repo.getProxyById(proxyId).catch(() => null)
    if (!config) continue

    const result = await probeProxy(config)
    const healthy = result.ok && result.reach?.telegram !== false

    if (healthy) {
      failCounts.delete(proxyId)
      await repo
        .markProxy(proxyId, 'ok', null, result.latencyMs ?? null)
        .catch(() => {})
      continue
    }

    const fails = (failCounts.get(proxyId) ?? 0) + 1
    failCounts.set(proxyId, fails)
    await repo
      .markProxy(
        proxyId,
        'error',
        result.error ?? 'Прокси не прошёл проверку доступности Telegram DC',
        null,
      )
      .catch(() => {})
    logger.warn(
      { proxyId, fails, error: result.error },
      'proxy health probe failed',
    )
    if (fails < FAIL_THRESHOLD) continue

    // Failover: repoint every Telegram channel on this dead proxy to the
    // fastest healthy free proxy of the same manager, then restart the
    // session so GramJS actually reconnects through it.
    for (const { channelId, managerId } of backed) {
      try {
        const candidates = await repo.listFailoverProxyCandidates(managerId)
        const next = candidates[0]
        if (!next) {
          logger.warn(
            { channelId, proxyId },
            'proxy failover: no healthy free proxy available',
          )
          continue
        }
        const moved = await repo.reassignChannelProxy(
          channelId,
          proxyId,
          next.id,
        )
        if (!moved) continue // admin repointed it mid-sweep — their call wins
        logger.info(
          {
            channelId,
            fromProxyId: proxyId,
            toProxyId: next.id,
            latencyMs: next.latency_ms,
          },
          'proxy failover: channel migrated to fastest healthy proxy',
        )
        // Restart through the normal serialized path so the reconnect never
        // races a mid-flight send/login on the same MTProto session.
        const channel = await repo.getChannel(channelId)
        if (channel && !channel.manually_stopped) {
          await registry.revive(channel).catch((err) => {
            logger.error(
              { err, channelId },
              'proxy failover: restart after migration failed',
            )
          })
        }
      } catch (err) {
        logger.error({ err, channelId }, 'proxy failover attempt failed')
      }
    }
    failCounts.delete(proxyId)
  }
}
