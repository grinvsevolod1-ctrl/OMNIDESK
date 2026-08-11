import type { getLeadCardDetailAction } from '@/app/actions/lead-cards'

/**
 * Типы блоков карточки выводятся из результата серверного экшена — так они
 * не расходятся с реальными данными и не требуют ручной синхронизации.
 * import type стирается на компиляции, поэтому импорт экшена в клиентские
 * компоненты безопасен.
 */
type LeadDetailResult = NonNullable<
  Awaited<ReturnType<typeof getLeadCardDetailAction>>
>

export type LeadCardView = LeadDetailResult['card']
export type LeadCommentView = LeadDetailResult['comments'][number]
export type LeadTransferView = LeadDetailResult['transfers'][number]
export type LeadStatusHistoryView = LeadDetailResult['statusHistory'][number]
