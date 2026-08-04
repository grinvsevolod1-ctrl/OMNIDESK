import 'server-only'
import {
  getAdminStats,
  getLeadAnalytics,
  listAllProxies,
  listManagers,
} from '@/lib/data'

/**
 * Proactive anomaly detection for the OS shell greeting. Instead of a bland
 * "чем помочь?", the copilot opens with "я нашёл проблему — разберём?".
 *
 * Uses only cheap, already-cached data-layer reads: this runs on every
 * /admin load, so no heavy scans here.
 */

export interface ShellInsight {
  /** Severity: problems first, then warnings, then info. */
  level: 'problem' | 'warning' | 'info'
  /** Human line, e.g. "3 прокси не работают". */
  text: string
  /** Command the admin can click to investigate. */
  prompt: string
}

const plural = (n: number, one: string, few: string, many: string) => {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

/** Collect current anomalies, worst first. Fail-open: never throws. */
export async function detectShellInsights(): Promise<ShellInsight[]> {
  try {
    const [stats, proxies, managers, leads] = await Promise.all([
      getAdminStats(),
      listAllProxies(),
      listManagers(),
      getLeadAnalytics(),
    ])

    const insights: ShellInsight[] = []

    // Dead proxies -----------------------------------------------------
    const deadProxies = proxies.filter((p) => p.status === 'error').length
    if (deadProxies > 0) {
      insights.push({
        level: 'problem',
        text: `${deadProxies} ${plural(deadProxies, 'прокси не работает', 'прокси не работают', 'прокси не работают')}`,
        prompt: 'Покажи прокси с ошибками',
      })
    }

    // Broken channels ----------------------------------------------------
    const brokenChannels = stats.totalChannels - stats.connectedChannels
    if (brokenChannels > 0) {
      insights.push({
        level: 'problem',
        text: `${brokenChannels} ${plural(brokenChannels, 'канал не подключён', 'канала не подключены', 'каналов не подключены')}`,
        prompt: 'Покажи статусы всех аккаунтов',
      })
    }

    // Blocked managers ---------------------------------------------------
    if (stats.blockedManagers > 0) {
      insights.push({
        level: 'warning',
        text: `${stats.blockedManagers} ${plural(stats.blockedManagers, 'менеджер заблокирован', 'менеджера заблокированы', 'менеджеров заблокированы')}`,
        prompt: 'Покажи список менеджеров',
      })
    }

    // Lead quality: too much «не ликвид» --------------------------------
    const total = leads.totalLeads
    const notLiquid = leads.byStatus?.not_liquid ?? 0
    if (total >= 20 && notLiquid / total > 0.5) {
      insights.push({
        level: 'warning',
        text: `Больше половины лидов — не ликвид (${notLiquid} из ${total})`,
        prompt: 'Покажи аналитику лидов',
      })
    }

    // Unanswered leads ----------------------------------------------------
    if (leads.unanswered > 0) {
      insights.push({
        level: leads.unanswered >= 5 ? 'problem' : 'warning',
        text: `${leads.unanswered} ${plural(leads.unanswered, 'лид ждёт ответа', 'лида ждут ответа', 'лидов ждут ответа')}`,
        prompt: 'Покажи аналитику лидов',
      })
    }

    // Idle system --------------------------------------------------------
    if (managers.length > 0 && stats.totalChannels === 0) {
      insights.push({
        level: 'info',
        text: 'Менеджеры есть, но ни одного канала не создано',
        prompt: 'Покажи каналы',
      })
    }

    const order = { problem: 0, warning: 1, info: 2 } as const
    return insights.sort((a, b) => order[a.level] - order[b.level]).slice(0, 4)
  } catch {
    // Insights are a nicety — a data hiccup must not break the shell.
    return []
  }
}
