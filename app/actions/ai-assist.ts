/**
 * БАРЕЛЬ: ai-assist разнесён на доменные модули. Существующие импорты
 * `@/app/actions/ai-assist` продолжают работать без изменений.
 *
 *   ai-assist-shared.ts    константы + тип AiDiagnostics (НЕ 'use server')
 *   ai-assist-settings.ts  настройки, база знаний, enrollment, диагностика, логи
 *   ai-assist-training.ts  тренер на аккаунте, уроки, поправки, подсказки
 *
 * НЕ 'use server': server actions реэкспортируются из своих 'use server'
 * модулей, типы — обычные реэкспорты.
 */

export type { AiDiagnostics } from './ai-assist-shared'

export {
  aiClearLogsAction,
  aiDeleteKnowledgeAction,
  aiDiagnosticsAction,
  aiEnrollAction,
  aiListDirectivesAction,
  aiListEnrollableAction,
  aiListEnrolledAction,
  aiListKnowledgeAction,
  aiLogsAction,
  aiSaveKnowledgeAction,
  aiSettingsAction,
  aiUnenrollAction,
  aiUpdateSettingsAction,
} from './ai-assist-settings'

export {
  aiAddCorrectionAction,
  aiDeleteCorrectionAction,
  aiDeleteLessonAction,
  aiListCorrectionsAction,
  aiListLessonsAction,
  aiReviewDialogsAction,
  aiReviewMessagesAction,
  aiSampleConversationsAction,
  aiSaveLessonAction,
  aiSuggestReplyAction,
  aiTrainableAccountsAction,
  aiTrainOnAccountAction,
} from './ai-assist-training'
