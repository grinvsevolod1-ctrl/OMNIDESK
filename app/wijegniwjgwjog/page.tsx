import { requireAdmin } from '@/lib/auth'
import { checkDbConnection, query } from '@/lib/db'
import { listAllChannels, listManagers } from '@/lib/data'
import { isWorkerConfigured, workerHealth } from '@/lib/worker-client'
import { SecretDashboard } from '@/components/admin/secret-dashboard'
import type { SecretStats } from '@/components/admin/secret-dashboard'

export const dynamic = 'force-dynamic'

const DAY_LABELS = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб']

/**
 * God-mode admin console. `requireAdmin()` gates the whole route; all heavy
 * aggregation runs here on the server (one round-trip per metric) so the client
 * bundle stays lean and only receives already-computed numbers.
 */
export default async function SecretPage() {
  await requireAdmin()

  const [managers, channels, msgCounts, msg7dRows, statusRows, convAgg, db] =
    await Promise.all([
      listManagers(),
      listAllChannels(),
      query<{ total: number; last24: number }>(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last24
        FROM messages
      `),
      query<{ day: string; incoming: number; outgoing: number }>(`
        SELECT
          to_char(date_trunc('day', created_at), 'YYYY-MM-DD') AS day,
          count(*) FILTER (WHERE direction = 'in')::int  AS incoming,
          count(*) FILTER (WHERE direction = 'out')::int AS outgoing
        FROM messages
        WHERE created_at > now() - interval '7 days'
        GROUP BY 1
        ORDER BY 1
      `),
      query<{ status: string; count: number }>(`
        SELECT status, count(*)::int AS count
        FROM conversations
        GROUP BY status
      `),
      query<{ total: number; unread: number }>(`
        SELECT
          count(*)::int AS total,
          coalesce(sum(unread), 0)::int AS unread
        FROM conversations
      `),
      checkDbConnection(),
    ])

  const workerConfigured = isWorkerConfigured
  const workerOnline = workerConfigured ? await workerHealth() : false

  // Build a continuous 7-day window so the trend chart never shows gaps.
  const msg7dMap = new Map(msg7dRows.map((r) => [r.day, r]))
  const now = new Date()
  const messages7d = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(now)
    d.setDate(now.getDate() - (6 - i))
    const key = d.toISOString().slice(0, 10)
    const row = msg7dMap.get(key)
    return {
      day: key,
      label: DAY_LABELS[d.getDay()],
      incoming: row?.incoming ?? 0,
      outgoing: row?.outgoing ?? 0,
    }
  })

  const channelsByType = Object.entries(
    channels.reduce<Record<string, number>>((acc, ch) => {
      acc[ch.type] = (acc[ch.type] ?? 0) + 1
      return acc
    }, {}),
  ).map(([type, count]) => ({ type, count }))

  const stats: SecretStats = {
    managersTotal: managers.length,
    managersActive: managers.filter((m) => m.status === 'active').length,
    managersOnLunch: managers.filter((m) => m.onLunch).length,
    channelsTotal: channels.length,
    channelsConnected: channels.filter((c) => c.status === 'connected').length,
    conversationsTotal: convAgg[0]?.total ?? 0,
    unreadTotal: convAgg[0]?.unread ?? 0,
    messagesTotal: msgCounts[0]?.total ?? 0,
    messages24h: msgCounts[0]?.last24 ?? 0,
    channelsByType,
    conversationsByStatus: statusRows,
    messages7d,
  }

  return (
    <SecretDashboard
      managers={managers}
      channels={channels}
      stats={stats}
      system={{
        workerConfigured,
        workerOnline,
        dbOk: db.ok,
        dbMessage: db.message,
        generatedAt: new Date().toISOString(),
      }}
    />
  )
}
