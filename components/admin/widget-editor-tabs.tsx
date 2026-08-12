/**
 * БАРЕЛЬ вкладок редактора лайв-чат-виджета. Реализация разнесена по
 * components/admin/widget-editor/: appearance-tab (внешний вид, аватар),
 * content-tab (тексты, быстрые ответы), messengers-tab (кнопки мессенджеров),
 * hours-tab (часы работы, офлайн-экран), behavior-tab (авто-открытие).
 * Существующий импорт `@/components/admin/widget-editor-tabs` менять не нужно.
 */

export type { TabProps } from './widget-editor/shared'
export { AppearanceTab } from './widget-editor/appearance-tab'
export { ContentTab } from './widget-editor/content-tab'
export { MessengersTab } from './widget-editor/messengers-tab'
export { HoursTab } from './widget-editor/hours-tab'
export { BehaviorTab } from './widget-editor/behavior-tab'
