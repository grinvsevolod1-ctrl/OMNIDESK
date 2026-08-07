'use server'

import { revalidatePath } from 'next/cache'
import { invalidateAnalytics } from '@/lib/analytics-cache'
import { getSession, hashPassword, requireAdmin } from '@/lib/auth'
import { generatePassword } from '@/lib/crypto'
import {
  createCurator,
  createManager,
  deleteManager,
  getManagerByEmail,
  getManagerById,
  getManagerByIdentifier,
  sanitizeUsername,
  updateManagerPassword,
  updateManagerStatus,
} from '@/lib/data'
import {
  listCuratorCities,
  parseCityList,
  setCuratorCities,
  suggestCities,
} from '@/lib/data/cities'
import { isAdminIdentity } from '@/lib/data/shared'

export interface ActionResult {
  ok: boolean
  message: string
  password?: string
  username?: string
}

// Server-issued passwords use the CSPRNG-backed generator in lib/crypto so they
// cannot be predicted (Math.random() is not cryptographically secure).
function genPassword(): string {
  return generatePassword(16)
}

export async function createManagerAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const usernameRaw = String(formData.get('username') ?? '').trim()
  let password = String(formData.get('password') ?? '')

  if (!name || !email) {
    return { ok: false, message: 'Укажите имя и email.' }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Введите корректный email.' }
  }
  // A custom login is optional; when provided it must be a valid handle.
  const username = usernameRaw ? sanitizeUsername(usernameRaw) : ''
  if (usernameRaw && (!username || username.length < 3)) {
    return {
      ok: false,
      message: 'Логин: минимум 3 символа (a-z, 0-9, точка, дефис, _).',
    }
  }
  if (!password) {
    password = genPassword()
  } else if (password.length < 8) {
    return { ok: false, message: 'Пароль должен быть не короче 8 символов.' }
  }

  const existing = await getManagerByEmail(email)
  if (existing) {
    return { ok: false, message: 'Аккаунт с таким email уже существует.' }
  }
  if (username) {
    const takenBy = await getManagerByIdentifier(username)
    if (takenBy) {
      return { ok: false, message: 'Этот логин уже занят.' }
    }
  }

  const passwordHash = await hashPassword(password)
  const created = await createManager({
    name,
    email,
    passwordHash,
    username: username || undefined,
    role: 'manager',
  })
  // A new manager appears in getManagerPerformance rollups; drop the analytics
  // cache so the dashboard lists them without waiting out the TTL.
  invalidateAnalytics()
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: `Менеджер ${name} создан.`,
    password,
    username: created.username ?? undefined,
  }
}

/**
 * Create a curator account. Same credentials flow as managers, plus one or
 * more cities the curator is responsible for (comma-separated; the first is
 * primary). Only the admin may call this.
 */
export async function createCuratorAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const usernameRaw = String(formData.get('username') ?? '').trim()
  const cities = parseCityList(String(formData.get('city') ?? ''))
  let password = String(formData.get('password') ?? '')

  if (!name || !email) {
    return { ok: false, message: 'Укажите имя и email.' }
  }
  if (cities.length === 0) {
    return {
      ok: false,
      message: 'Укажите хотя бы один город, за который отвечает куратор.',
    }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Введите корректный email.' }
  }
  const username = usernameRaw ? sanitizeUsername(usernameRaw) : ''
  if (usernameRaw && (!username || username.length < 3)) {
    return {
      ok: false,
      message: 'Логин: минимум 3 символа (a-z, 0-9, точка, дефис, _).',
    }
  }
  if (!password) {
    password = genPassword()
  } else if (password.length < 8) {
    return { ok: false, message: 'Пароль должен быть не короче 8 символов.' }
  }

  const existing = await getManagerByEmail(email)
  if (existing) {
    return { ok: false, message: 'Аккаунт с таким email уже существует.' }
  }
  if (username) {
    const takenBy = await getManagerByIdentifier(username)
    if (takenBy) {
      return { ok: false, message: 'Этот логин уже занят.' }
    }
  }

  const passwordHash = await hashPassword(password)
  const created = await createCurator({
    name,
    email,
    passwordHash,
    username: username || undefined,
    city: cities[0],
  })
  // Store the full (canonicalized) city set; also fixes managers.city spelling.
  let canonical: string[]
  try {
    canonical = await setCuratorCities(created.id, cities)
  } catch (err) {
    if (isMissingTableError(err)) {
      // Migrations 114+ not applied yet: the account exists (legacy
      // managers.city is set), only the multi-city dictionary is missing.
      revalidatePath('/admin/managers')
      revalidatePath('/admin')
      return {
        ok: true,
        message: `Куратор ${name} (${cities[0]}) создан, но список городов не сохранён: на сервере не применены миграции БД. Выполните pnpm db:migrate и задайте города повторно.`,
        password,
        username: created.username ?? undefined,
      }
    }
    // Аккаунт уже создан (managers.city заполнен) — не роняем экшен digest'ом,
    // а честно сообщаем, что мульти-город не сохранился и почему.
    console.error('[v0] createCurator setCuratorCities failed:', err)
    revalidatePath('/admin/managers')
    revalidatePath('/admin')
    return {
      ok: true,
      message: `Куратор ${name} (${cities[0]}) создан, но список городов не сохранён (${err instanceof Error ? err.message : 'ошибка базы данных'}). Откройте «Города» у куратора и сохраните повторно.`,
      password,
      username: created.username ?? undefined,
    }
  }
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: `Куратор ${name} (${canonical.join(', ')}) создан.`,
    password,
    username: created.username ?? undefined,
  }
}

/** Postgres 42P01 (undefined_table): pending migration on this deployment. */
function isMissingTableError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '42P01'
  )
}

export async function setManagerStatusAction(
  id: string,
  status: 'active' | 'blocked',
): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }
  // The administrator is authenticated from env vars and is not a manager.
  // Blocking it would be meaningless and could lock the panel — refuse.
  if (isAdminIdentity(manager)) {
    return { ok: false, message: 'Администратора нельзя блокировать.' }
  }
  await updateManagerStatus(id, status)
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  const label = manager.role === 'curator' ? 'Куратор' : 'Менеджер'
  return {
    ok: true,
    message:
      status === 'blocked'
        ? `${label} заблокирован.`
        : `${label} разблокирован.`,
  }
}

export async function resetManagerPasswordAction(
  id: string,
): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }
  const password = genPassword()
  const passwordHash = await hashPassword(password)
  await updateManagerPassword(id, passwordHash)
  return {
    ok: true,
    message: `Новый пароль сгенерирован для ${manager.name}.`,
    password,
  }
}

/**
 * Replace the curator's city list (comma-separated, first = primary).
 * managers.city is kept in sync with the primary city.
 */
export async function updateCuratorCityAction(
  id: string,
  city: string,
): Promise<ActionResult> {
  await requireAdmin()
  const account = await getManagerById(id)
  if (!account) return { ok: false, message: 'Аккаунт не найден.' }
  if (account.role !== 'curator') {
    return { ok: false, message: 'Город задаётся только для кураторов.' }
  }
  const cities = parseCityList(city)
  if (cities.length === 0) {
    return { ok: false, message: 'Укажите хотя бы один город.' }
  }
  let canonical: string[]
  try {
    canonical = await setCuratorCities(id, cities)
  } catch (err) {
    if (isMissingTableError(err)) {
      return {
        ok: false,
        message:
          'На сервере не применены миграции БД (таблицы городов ещё нет). Выполните pnpm db:migrate на VPS и повторите.',
      }
    }
    // Любая другая ошибка БД (права, констрейнты, обрыв соединения): раньше
    // здесь был `throw err`, и админ получал безликое digest-падение страницы.
    // Возвращаем реальный текст — этот экшен доступен только админу.
    console.error('[v0] updateCuratorCityAction failed:', err)
    return {
      ok: false,
      message: `Не удалось сохранить города: ${err instanceof Error ? err.message : 'ошибка базы данных'}`,
    }
  }
  revalidatePath('/admin/managers')
  revalidatePath('/admin/curators')
  return { ok: true, message: `Города обновлены: ${canonical.join(', ')}.` }
}

/** City name suggestions from the dictionary (for form autocompletes). */
export async function suggestCitiesAction(q?: string): Promise<string[]> {
  const session = await getSession()
  if (!session) return []
  return suggestCities(q).catch(() => [])
}

/** Cities covered by a curator (admin UI helper). */
export async function listCuratorCitiesAction(id: string): Promise<string[]> {
  await requireAdmin()
  return listCuratorCities(id).catch(() => [])
}

export async function deleteManagerAction(id: string): Promise<ActionResult> {
  await requireAdmin()
  const manager = await getManagerById(id)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }
  if (isAdminIdentity(manager)) {
    return { ok: false, message: 'Администратора нельзя удалить.' }
  }
  await deleteManager(id)
  invalidateAnalytics()
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  const label = manager.role === 'curator' ? 'Куратор' : 'Менеджер'
  return { ok: true, message: `${label} ${manager.name} удалён.` }
}
