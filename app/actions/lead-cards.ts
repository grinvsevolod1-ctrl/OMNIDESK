/**
 * Server actions карточек лидов — тонкий баррель.
 *
 * Сами действия живут в фокусных 'use server'-модулях под ./lead-cards/
 * (core, attachments, admin, stats, lifecycle), общие не-action хелперы —
 * в ./lead-cards/shared. Потребители продолжают импортировать всё из
 * '@/app/actions/lead-cards' как раньше.
 *
 * Каждое действие само проверяет сессию/роль на сервере — гвард страницы
 * недостаточен: server action это отдельный POST-эндпоинт.
 */

export type {
  LeadAttachmentView,
  LeadCardActionResult,
} from './lead-cards/shared'

export * from './lead-cards/core'
export * from './lead-cards/attachments'
export * from './lead-cards/admin'
export * from './lead-cards/stats'
export * from './lead-cards/lifecycle'
