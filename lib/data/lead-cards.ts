/**
 * Lead cards: structured lead data filled from a conversation and optionally
 * transferred to a curator matched by city. Curators maintain a daily status
 * and comment trail on each transferred lead.
 *
 * Integrity rules (migration 114):
 * - Deleting a manager keeps the cards (manager_id -> NULL).
 * - Deleting a comment author keeps the comment with a name snapshot.
 * - Every transfer is recorded in lead_transfers with name snapshots.
 *
 * Это БАРЕЛЬ: монолит распилен по доменам, всё ре-экспортируется отсюда,
 * существующие импорты `@/lib/data/lead-cards` менять не нужно.
 *   lead-cards-core.ts       типы, CARD_SELECT, конвертеры строк
 *   lead-cards-queries.ts    read-side выборки + контактная дедупликация
 *   lead-cards-upsert.ts     создание/обновление из формы менеджера
 *   lead-cards-lifecycle.ts  передача куратору, статусы, комментарии
 *   lead-cards-archive.ts    архив финальных лидов + авто-архив (cron)
 *   lead-history.ts          журнал статусов и передач
 *   lead-admin.ts            админская выборка/корзина/inline-редактор
 *   lead-curators.ts         подбор кураторов по городу
 *   lead-discipline.ts       дисциплина кураторов (daily gate)
 */

/* Core types and converters. */
export {
  CARD_SELECT,
  toDateOnly,
  toLeadCard,
  type LeadCard,
  type LeadCardComment,
  type LeadCardRow,
  type LeadCommentRevision,
  type LeadTransfer,
} from './lead-cards-core'

/* Read-side queries + contact-identity dedup. */
export {
  findLeadCardForContact,
  getLeadCardByConversation,
  getLeadCardById,
  listArchivedLeadsForCurator,
  listLeadCardsForCurator,
} from './lead-cards-queries'

/* Create/update from the manager's lead form. */
export {
  findDuplicateLeadWarning,
  upsertLeadCard,
  type UpsertLeadCardInput,
  type UpsertLeadCardResult,
} from './lead-cards-upsert'

/* Post-transfer lifecycle: transfer, status confirmation, comments, claim. */
export {
  addLeadComment,
  adminSetLeadStatus,
  claimPoolLead,
  editLeadComment,
  listLeadComments,
  transferLeadToCurator,
  updateLeadStatus,
} from './lead-cards-lifecycle'

/* Archive lifecycle. */
export {
  archiveLeadWithStatus,
  autoArchiveFinalLeads,
  setLeadArchived,
} from './lead-cards-archive'

/* Curator pickers. */
export {
  findCuratorsByCity,
  listActiveCurators,
  type CuratorWithLoad,
} from './lead-curators'

/* Status/transfer history. */
export {
  listLeadStatusHistory,
  listLeadTransfers,
  type LeadStatusHistoryEntry,
} from './lead-history'

/* Admin overview, trash (soft delete) and inline editing. */
export {
  hardDeleteLeadCard,
  isInlineLeadField,
  listAllTransferredLeads,
  listArchivedLeadsAdmin,
  listDeletedLeads,
  parseLeadSearch,
  purgeDeletedLeads,
  restoreLeadCard,
  softDeleteLeadCard,
  updateLeadCardField,
  type AllLeadsFilter,
  type DeletedLead,
  type InlineLeadField,
} from './lead-admin'

/* Discipline / daily-gate queries. */
export {
  countLeadsNeedingStatus,
  getCuratorDiscipline,
  getCuratorDisciplineHistory,
  listCuratorsWithOverdueStatuses,
  type CuratorDiscipline,
  type CuratorDisciplineHistory,
} from './lead-discipline'
