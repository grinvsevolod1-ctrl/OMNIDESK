/**
 * БАРЕЛЬ: finance-actions разнесены на доменные модули. Существующие импорты
 * `@/app/actions/finance` продолжают работать без изменений.
 *
 *   finance-shared.ts     FinanceResult, лимиты, парсеры форм (НЕ 'use server')
 *   finance-workspace.ts  источники, вкладки, расходы, чек-листы
 *   finance-ads.ts        рекламные кабинеты, синк Яндекс.Директа, пополнения, статистика
 *   finance-vault.ts      хранилище секретов (создание/импорт/избранное)
 *
 * НЕ 'use server': server actions реэкспортируются из своих 'use server'
 * модулей, типы — обычные реэкспорты.
 */

export type { FinanceResult } from './finance-shared'

export {
  addTaskAction,
  createEntryAction,
  createResourceAction,
  createSectionAction,
  deleteEntryAction,
  deleteResourceAction,
  deleteSectionAction,
  deleteTaskAction,
  moveEntryAction,
  renameSectionAction,
  toggleTaskAction,
  updateEntryAction,
  updateResourceAction,
} from './finance-workspace'

export {
  addAdStatAction,
  addAdTopupAction,
  createAdAccountAction,
  deleteAdAccountAction,
  deleteAdStatAction,
  deleteAdTopupAction,
  syncAdAccountAction,
  updateAdAccountAction,
} from './finance-ads'

export {
  createVaultItemAction,
  deleteVaultItemAction,
  importVaultItemsAction,
  toggleVaultFavoriteAction,
  updateVaultItemAction,
} from './finance-vault'
