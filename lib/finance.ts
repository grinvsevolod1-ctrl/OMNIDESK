/**
 * Data-access layer for the «Учёт» (finance) admin tab.
 *
 * У бизнеса нет доходов — только расходы и реклама. Ключевые метрики: ЛИДЫ,
 * расход на рекламу, баланс кабинетов, CPL.
 *
 * Модель:
 *   Ресурс (site.com)
 *     ├── Рекламные кабинеты  →  Пополнения (+баланс) + Статистика (−баланс, метрики)
 *     └── Разделы расходов (вкладки) → Записи расходов → чек-лист задач
 *
 * This file is a thin barrel. The SQL lives in focused per-domain modules under
 * ./finance/ (read / resources / ad-accounts / vault), with the shared row
 * shapes + mappers in ./finance/rows. Types and enum-arrays live in
 * ./finance-types (no DB import, so they are safe in client components). We
 * re-export everything so existing server imports from '@/lib/finance' keep
 * working unchanged.
 */

export {
  AD_PLATFORMS,
  AD_STATUSES,
  AD_METRIC_KEYS,
  AD_METRIC_LABELS,
  FINANCE_CURRENCIES,
  FINANCE_ENTRY_STATUSES,
  VAULT_CATEGORIES,
  adBaseMetrics,
  adEffectiveMetrics,
} from './finance-types'
export type {
  AdMetricKey,
  AdOverride,
  AdPlatform,
  AdStatus,
  FinanceAdAccount,
  FinanceAdStat,
  FinanceAdSyncStat,
  FinanceAdTopup,
  FinanceCurrency,
  FinanceData,
  FinanceEntry,
  FinanceEntryStatus,
  FinanceResource,
  FinanceSection,
  FinanceTask,
  VaultCategory,
  VaultField,
  VaultItem,
} from './finance-types'

export * from './finance/read'
export * from './finance/resources'
export * from './finance/ad-accounts'
export * from './finance/vault'
