/**
 * Канонический результат server action.
 *
 * Раньше `interface ActionResult { ok; message }` объявлялся локально в
 * нескольких модулях экшенов (admin-secret/shared.ts, managers.ts, …), и
 * клиентские компоненты импортировали тип из чужих server-модулей. Теперь
 * единственный источник — здесь; серверные барели реэкспортируют его, чтобы
 * существующие импорты продолжали работать.
 *
 * Соглашение: `ok: false` — ОЖИДАЕМАЯ бизнес-ошибка с человекочитаемым
 * `message` для тоста; неожиданные ошибки экшен не заворачивает в ActionResult,
 * а бросает (их ловит error boundary / logServerError).
 */
export interface ActionResult {
  ok: boolean
  message: string
}
