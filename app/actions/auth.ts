/**
 * БАРЕЛЬ: auth разнесён на модули по шагам флоу входа. Существующие импорты
 * `@/app/actions/auth` продолжают работать без изменений.
 *
 *   auth-shared.ts   типы состояний (LoginState, Verify2faState) и общие
 *                    хелперы (IP/UA, временный пароль) — НЕ 'use server'
 *   auth-login.ts    шаг 1: пароль (loginAction) + выход (logoutAction)
 *   auth-twofa.ts    шаг 2: 2FA-код (verify2faAction, cancel2faAction)
 *
 * НЕ 'use server': server actions реэкспортируются из своих 'use server'
 * модулей, типы — обычные реэкспорты.
 */

export type { LoginState, Verify2faState } from './auth-shared'

export { loginAction, logoutAction } from './auth-login'

export { cancel2faAction, verify2faAction } from './auth-twofa'
