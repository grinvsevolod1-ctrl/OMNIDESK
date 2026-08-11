import { requireAdmin } from '@/lib/auth'
import { isGodPasscodeConfigured, isGodUnlocked } from '@/lib/god-gate'
import { listAllChannels, listCurators, listManagers, getTelegramExclusiveSession, getFake502 } from '@/lib/data'
import {
  getFinanceData,
  adBaseMetrics,
  adEffectiveMetrics,
  type AdPlatform,
} from '@/lib/finance'
import { getGatewayBalance } from '@/lib/ai/gateway-balance'
import { SecretDashboard } from '@/components/admin/secret-dashboard'
import { SecretGate } from '@/components/admin/secret-gate'
import type { SecretAdAccount } from '@/components/admin/secret-ads-tab'

export const dynamic = 'force-dynamic'

const AD_PLATFORM_LABEL: Record<AdPlatform, string> = {
  yandex_direct: 'Яндекс Директ',
  google_ads: 'Google Ads',
  vk_ads: 'VK Реклама',
  telegram_ads: 'Telegram Ads',
  mytarget: 'myTarget',
  other: 'Другое',
}

/**
 * God-mode admin console. `requireAdmin()` gates the whole route; all heavy
 * aggregation runs here on the server (one round-trip per metric) so the client
 * bundle stays lean and only receives already-computed numbers.
 */
export default async function SecretPage() {
  await requireAdmin()

  // Second factor: even a logged-in admin must pass the secret passcode gate
  // (when SECRET_PANEL_PASSWORD is configured) before any data is fetched.
  if (!(await isGodUnlocked())) return <SecretGate />

  const [
    managers,
    curators,
    channels,
    finance,
    tgExclusive,
    fake502,
    aiBalance,
  ] = await Promise.all([
      listManagers(),
      listCurators(),
      listAllChannels(),
      getFinanceData(),
      getTelegramExclusiveSession(),
      getFake502(),
      // Live AI Gateway balance — fetched in the same parallel batch so it
      // doesn't add a serial round-trip to the page's TTFB.
      getGatewayBalance(),
    ])

  const adAccounts: SecretAdAccount[] = finance.adAccounts.map((a) => ({
    id: a.id,
    name: a.name,
    platformLabel: AD_PLATFORM_LABEL[a.platform] ?? 'Другое',
    externalEnabled: a.externalEnabled,
    hasToken: a.hasToken,
    lastSyncAt: a.lastSyncAt,
    syncError: a.syncError,
    currency: a.currency,
    base: adBaseMetrics(a),
    effective: adEffectiveMetrics(a),
    overrides: a.overrides,
  }))

  return (
    <SecretDashboard
      managers={managers}
      curators={curators}
      channels={channels}
      adAccounts={adAccounts}
      tgExclusive={tgExclusive}
      system={{
        gateEnabled: isGodPasscodeConfigured(),
        aiBalance: aiBalance.balance,
        aiTotalUsed: aiBalance.totalUsed,
        aiBalanceOk: aiBalance.ok,
        aiBalanceMessage: aiBalance.message ?? null,
        fake502,
      }}
    />
  )
}
