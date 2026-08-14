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
import { resolveCityOrRegion } from '@/lib/data/regions'
import { writeAudit } from '@/lib/data/audit'
import { isAdminIdentity } from '@/lib/data/shared'
import type { ActionResult as BaseActionResult } from '@/lib/types'

// Расширение канонического ActionResult (lib/types/actions.ts): экшены этого
// модуля дополнительно возвращают выданный пароль/логин при создании учётки.
export interface ActionResult extends BaseActionResult {
  password?: string
  username?: string
}

// Server-issued passwords use the CSPRNG-backed generator in lib/crypto so they
// cannot be predicted (Math.random() is not cryptographically secure).
function genPassword(): string {
  return generatePassword(16)
}

/**
 * Города куратора: известные городá/регионы канонизируются по справочнику
 * («Чечня» → «Чеченская Республика»), а НЕИЗВЕСТНЫЕ населённые пункты
 * (посёлки вроде «Внуково») принимаются как есть — setCuratorCities сам
 * добавит их в словарь. Раньше валидация была «только справочник» и не
 * давала покрывать реальные, но отсутствующие в базе места.
 */
async function resolveCuratorCities(
  raw: string[],
): Promise<{ ok: true; cities: string[] } | { ok: false; message: string }> {
  const resolved: string[] = []
  for (const item of raw) {
    const hit = await resolveCityOrRegion(item).catch(() => null)
    const value = hit ? hit.value : item
    if (value && !resolved.includes(value)) resolved.push(value)
  }
  if (resolved.length === 0) {
    return { ok: false, message: 'Укажите хотя бы один город или регион.' }
  }
  return { ok: true, cities: resolved }
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
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'manager.create',
    entityType: 'manager',
    entityId: created.id,
    details: { name, email },
  })
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
  const rawCities = parseCityList(String(formData.get('city') ?? ''))
  let password = String(formData.get('password') ?? '')

  if (!name || !email) {
    return { ok: false, message: 'Укажите имя и email.' }
  }
  if (rawCities.length === 0) {
    return {
      ok: false,
      message: 'Укажите хотя бы один город, за который отвечает менеджер по кадрам.',
    }
  }
  // Только справочник: город или регион («Чечня» → «Чеченская Республика»).
  const cityCheck = await resolveCuratorCities(rawCities)
  if (!cityCheck.ok) return { ok: false, message: cityCheck.message }
  const cities = cityCheck.cities
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
        message: `Менеджер по кадрам ${name} (${cities[0]}) создан, но список городов не сохранён: на сервере не применены миграции БД. Выполните pnpm db:migrate и задайте города повторно.`,
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
      message: `Менеджер по кадрам ${name} (${cities[0]}) создан, но список городов не сохранён (${err instanceof Error ? err.message : 'ошибка базы данных'}). Откройте «Города» у менеджера по кадрам и сохраните повторно.`,
      password,
      username: created.username ?? undefined,
    }
  }
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  return {
    ok: true,
    message: `Менеджер по кадрам ${name} (${canonical.join(', ')}) создан.`,
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
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: status === 'blocked' ? 'manager.block' : 'manager.unblock',
    entityType: 'manager',
    entityId: id,
    details: { name: manager.name, role: manager.role },
  })
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  const label = manager.role === 'curator' ? 'Менеджер по кадрам' : 'Менеджер'
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
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'manager.password_reset',
    entityType: 'manager',
    entityId: id,
    details: { name: manager.name },
  })
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
    return { ok: false, message: 'Город задаётся только для менеджеров по кадрам.' }
  }
  const rawCities = parseCityList(city)
  if (rawCities.length === 0) {
    return { ok: false, message: 'Укажите хотя бы один город.' }
  }
  // Только справочник: город или регион («Чечня» → «Чеченская Республика»).
  const cityCheck = await resolveCuratorCities(rawCities)
  if (!cityCheck.ok) return { ok: false, message: cityCheck.message }
  const cities = cityCheck.cities
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

/**
 * Мои ГЕО: менеджер по кадрам читает список СВОИХ городов. Доступ только к
 * собственному аккаунту (session.sub), чужие списки — только через админский
 * listCuratorCitiesAction.
 */
export async function listMyCitiesAction(): Promise<string[]> {
  const session = await getSession()
  if (!session || session.role !== 'curator') return []
  return listCuratorCities(session.sub).catch(() => [])
}

/**
 * Мои ГЕО: менеджер по кадрам сам обновляет список своих городов
 * (добавляет/удаляет, включая населённые пункты, которых нет в справочнике).
 * Та же логика канонизации, что у админа; изменение пишется в аудит.
 */
export async function updateMyCitiesAction(
  city: string,
): Promise<ActionResult> {
  const session = await getSession()
  if (!session || session.role !== 'curator') {
    return { ok: false, message: 'Нет доступа.' }
  }
  const rawCities = parseCityList(city)
  if (rawCities.length === 0) {
    return { ok: false, message: 'Укажите хотя бы один город.' }
  }
  const cityCheck = await resolveCuratorCities(rawCities)
  if (!cityCheck.ok) return { ok: false, message: cityCheck.message }
  let canonical: string[]
  try {
    canonical = await setCuratorCities(session.sub, cityCheck.cities)
  } catch (err) {
    if (isMissingTableError(err)) {
      return {
        ok: false,
        message:
          'На сервере не применены миграции БД (таблицы городов ещё нет). Обратитесь к администратору.',
      }
    }
    console.error('[v0] updateMyCitiesAction failed:', err)
    return {
      ok: false,
      message: `Не удалось сохранить города: ${err instanceof Error ? err.message : 'ошибка базы данных'}`,
    }
  }
  await writeAudit({
    actorRole: 'curator',
    actorId: session.sub,
    actorLabel: session.name ?? 'Менеджер по кадрам',
    action: 'curator.cities_update',
    entityType: 'manager',
    entityId: session.sub,
    details: { cities: canonical },
  })
  revalidatePath('/curator/settings')
  revalidatePath('/admin/managers')
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
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'manager.delete',
    entityType: 'manager',
    entityId: id,
    details: { name: manager.name, role: manager.role },
  })
  revalidatePath('/admin/managers')
  revalidatePath('/admin')
  const label = manager.role === 'curator' ? 'Менеджер по кадрам' : 'Менеджер'
  return { ok: true, message: `${label} ${manager.name} удалён.` }
}
