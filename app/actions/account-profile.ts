'use server'

import { revalidatePath } from 'next/cache'
import {
  comparePassword,
  getSession,
  hashPassword,
  requireAdmin,
  requireManager,
  startSession,
} from '@/lib/auth'
import {
  getManagerAuthState,
  getManagerByEmail,
  getManagerById,
  getManagerByIdentifier,
  getManagerByIdWithSecret,
  getManagerOnLunch,
  sanitizeUsername,
  setManagerOnLunch,
  tryGoOnLunch,
  updateManagerAvatar,
  updateManagerPassword,
  updateManagerProfile,
} from '@/lib/data'
import { writeAudit } from '@/lib/data/audit'
import { getAdminAvatar, setAdminAvatar } from '@/lib/data/admin-avatar'
import { isDemonAvatarPreset } from '@/lib/avatar-presets'
import type { SimpleResult } from './account-shared'

/**
 * Toggle the calling manager's "on lunch" availability. While on lunch, NEW
 * conversations are routed (round-robin) to other available managers; existing
 * conversations stay put. Returns the resulting state so the UI stays in sync.
 */
export async function setLunchAction(
  onLunch: boolean,
): Promise<{ ok: boolean; onLunch: boolean; message: string }> {
  const session = await requireManager()

  if (onLunch) {
    // Atomic guard: check-and-set runs in ONE transaction under an advisory
    // lock (tryGoOnLunch), so simultaneous clicks are serialized and the last
    // available manager is always blocked. The previous two-query version
    // raced: everyone pressing "lunch" at the same minute passed the check
    // together and the whole team could walk out at once.
    let allowed: boolean
    try {
      allowed = await tryGoOnLunch(session.sub)
    } catch (err) {
      // Fail CLOSED for going on lunch: if we can't verify availability,
      // don't risk leaving the line unmanned.
      console.error('[panel] setLunchAction (go on lunch) failed:', err)
      return {
        ok: false,
        onLunch: false,
        message: 'Не удалось обновить статус.',
      }
    }
    if (!allowed) {
      return {
        ok: false,
        onLunch: false,
        message:
          'Вы сейчас единственный менеджер на линии. Дождитесь, пока вернётся кто-то ещё, прежде чем уходить на обед.',
      }
    }
  } else {
    // Coming BACK from lunch is always allowed — never trap a manager away.
    try {
      await setManagerOnLunch(session.sub, false)
    } catch (err) {
      console.error('[panel] setLunchAction (return) failed:', err)
      return {
        ok: false,
        onLunch: true,
        message: 'Не удалось обновить статус.',
      }
    }
  }
  // The inbox lists conversations for this manager; refresh after a change.
  revalidatePath('/app/inbox')
  return {
    ok: true,
    onLunch,
    message: onLunch
      ? 'Вы на обеде — новые диалоги уйдут другим менеджерам.'
      : 'Вы снова на линии.',
  }
}

/** Read the calling manager's current "on lunch" flag (for initial UI state). */
export async function getLunchStateAction(): Promise<boolean> {
  const session = await requireManager()
  return getManagerOnLunch(session.sub)
}

/** Роли, чьи учётки живут в таблице managers и правят свой профиль сами. */
function isSelfManagedRole(
  role: string,
): role is 'manager' | 'curator' | 'head' | 'buyer' {
  return (
    role === 'manager' ||
    role === 'curator' ||
    role === 'head' ||
    role === 'buyer'
  )
}

export async function changeOwnPasswordAction(
  formData: FormData,
): Promise<SimpleResult> {
  // Sales managers, curators (менеджеры по кадрам) и руководители живут в одной
  // таблице managers и меняют свой пароль через это действие.
  const session = await getSession()
  if (!session || !isSelfManagedRole(session.role)) {
    return { ok: false, message: 'Нет доступа.' }
  }
  const current = String(formData.get('current') ?? '')
  const next = String(formData.get('next') ?? '')

  if (next.length < 8) {
    return { ok: false, message: 'Новый пароль должен быть не короче 8 символов.' }
  }
  // По id, а не по email: email мог быть только что изменён в профиле.
  const manager = await getManagerByIdWithSecret(session.sub)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }

  const ok = await comparePassword(current, manager.passwordHash)
  if (!ok) return { ok: false, message: 'Текущий пароль неверен.' }

  await updateManagerPassword(manager.id, await hashPassword(next))
  await writeAudit({
    actorRole: session.role,
    actorId: manager.id,
    actorLabel: manager.name,
    action: 'account.password_change',
    entityType: 'manager',
    entityId: manager.id,
  })

  // updateManagerPassword bumps session_version, which would invalidate THIS
  // user's own cookie. Re-issue the session with the fresh version so the
  // user who just changed their password stays signed in, while every other
  // outstanding session (e.g. on another device) is forced to re-authenticate.
  const fresh = await getManagerAuthState(manager.id)
  await startSession({
    sub: manager.id,
    role: session.role,
    email: manager.email,
    name: manager.name,
    sv: fresh?.sessionVersion ?? 0,
  })

  return { ok: true, message: 'Пароль обновлён.' }
}

/**
 * Самостоятельная правка профиля (имя, логин, email) для менеджера, куратора
 * и руководителя. Логин и почта уникальны на всю таблицу managers; пустой
 * логин допустим (вход по email). Имя и email кэшируются в сессии/JWT, поэтому
 * после сохранения перевыпускаем cookie текущей сессии со свежими значениями
 * (session_version не двигаем — другие устройства остаются в системе).
 */
export async function updateMyProfileAction(
  formData: FormData,
): Promise<SimpleResult> {
  const session = await getSession()
  if (!session || !isSelfManagedRole(session.role)) {
    return { ok: false, message: 'Нет доступа.' }
  }

  const name = String(formData.get('name') ?? '').trim()
  const email = String(formData.get('email') ?? '')
    .trim()
    .toLowerCase()
  const usernameRaw = String(formData.get('username') ?? '').trim()

  if (!name) return { ok: false, message: 'Укажите имя.' }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { ok: false, message: 'Введите корректный email.' }
  }
  // Логин необязателен; если задан — валидный хэндл (как при создании учётки).
  const username = usernameRaw ? sanitizeUsername(usernameRaw) : ''
  if (usernameRaw && (!username || username.length < 3)) {
    return {
      ok: false,
      message: 'Логин: минимум 3 символа (a-z, 0-9, точка, дефис, _).',
    }
  }

  const manager = await getManagerById(session.sub)
  if (!manager) return { ok: false, message: 'Аккаунт не найден.' }

  // Уникальность email и логина: занятость проверяем по чужим учёткам.
  if (email !== manager.email) {
    const byEmail = await getManagerByEmail(email)
    if (byEmail && byEmail.id !== manager.id) {
      return { ok: false, message: 'Этот email уже занят.' }
    }
  }
  if (username && username !== (manager.username ?? '')) {
    const byLogin = await getManagerByIdentifier(username)
    if (byLogin && byLogin.id !== manager.id) {
      return { ok: false, message: 'Этот логин уже занят.' }
    }
  }

  try {
    await updateManagerProfile(manager.id, {
      name,
      username: username || null,
      email,
    })
  } catch (err) {
    // Гонка двух сохранений может упереться в уникальный индекс (23505).
    const code =
      typeof err === 'object' && err && 'code' in err
        ? (err as { code?: string }).code
        : undefined
    if (code === '23505') {
      return { ok: false, message: 'Логин или email уже заняты.' }
    }
    console.error('[panel] updateMyProfileAction failed:', err)
    return { ok: false, message: 'Не удалось сохранить профиль.' }
  }

  await writeAudit({
    actorRole: session.role,
    actorId: manager.id,
    actorLabel: name,
    action: 'account.profile_update',
    entityType: 'manager',
    entityId: manager.id,
    details: { name, email, username: username || null },
  })

  // Имя/почта живут в JWT — перевыпускаем cookie со свежими значениями.
  const fresh = await getManagerAuthState(manager.id)
  await startSession({
    sub: manager.id,
    role: session.role,
    email,
    name,
    sv: fresh?.sessionVersion ?? 0,
  })

  revalidatePath('/app/settings')
  revalidatePath('/curator/settings')
  revalidatePath('/head/settings')
  return { ok: true, message: 'Профиль обновлён.' }
}

/**
 * Максимальный размер сохранённой аватарки (data:-URL). Картинка сжимается на
 * клиенте до квадрата 256×256, так что реальные значения — десятки КБ; лимит
 * с большим запасом отсекает попытки записать в БД гигантскую строку. base64
 * раздувает бинарь примерно в 4/3, поэтому 512 КБ строки ≈ ~380 КБ картинки.
 */
const MAX_AVATAR_DATAURL_LEN = 512 * 1024

/** Разрешённые форматы локальной аватарки (сжатие на клиенте — JPEG/WebP/PNG). */
const AVATAR_DATAURL_RE = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

/**
 * Загрузка / сброс собственной аватарки для ролей из таблицы managers
 * (менеджер, куратор, руководитель). ПОЛНОСТЬЮ локально: принимаем сжатый
 * на клиенте data:-URL, валидируем формат и размер и кладём в БД. Пустая
 * строка / null — сброс к инициалам. Никаких сторонних хранилищ.
 */
export async function updateMyAvatarAction(
  dataUrl: string | null,
): Promise<SimpleResult> {
  const session = await getSession()
  if (!session || !isSelfManagedRole(session.role)) {
    return { ok: false, message: 'Нет доступа.' }
  }

  const value = (dataUrl ?? '').trim()

  // Сброс аватарки.
  if (!value) {
    await updateManagerAvatar(session.sub, null)
    await writeAudit({
      actorRole: session.role,
      actorId: session.sub,
      actorLabel: session.name,
      action: 'account.avatar_update',
      entityType: 'manager',
      entityId: session.sub,
      details: { cleared: true },
    })
    revalidatePath('/app/settings')
    revalidatePath('/curator/settings')
    revalidatePath('/head/settings')
    return { ok: true, message: 'Аватар удалён.' }
  }

  // Готовый демонический образ — короткий путь /avatars/demon-XX.png.
  const isPreset = isDemonAvatarPreset(value)
  if (!isPreset) {
    if (value.length > MAX_AVATAR_DATAURL_LEN) {
      return {
        ok: false,
        message: 'Изображение слишком большое. Выберите файл поменьше.',
      }
    }
    if (!AVATAR_DATAURL_RE.test(value)) {
      return {
        ok: false,
        message: 'Неподдерживаемый формат. Загрузите PNG, JPEG или WebP.',
      }
    }
  }

  await updateManagerAvatar(session.sub, value)
  await writeAudit({
    actorRole: session.role,
    actorId: session.sub,
    actorLabel: session.name,
    action: 'account.avatar_update',
    entityType: 'manager',
    entityId: session.sub,
    details: { preset: isPreset ? value : undefined },
  })
  revalidatePath('/app/settings')
  revalidatePath('/curator/settings')
  revalidatePath('/head/settings')
  revalidatePath('/buyer/settings')
  return { ok: true, message: 'Аватар обновлён.' }
}

/**
 * Аватарка администратора. У админа нет строки в `managers`, поэтому его аватар
 * хранится в kv-таблице `app_settings` (ключ на каждого админа). Принимает либо
 * готовый образ (/avatars/demon-XX.png), либо сжатый на клиенте data:-URL;
 * пустая строка / null — сброс к инициалам. Никаких сторонних хранилищ.
 */
export async function updateAdminAvatarAction(
  dataUrl: string | null,
): Promise<SimpleResult> {
  const session = await requireAdmin()

  const value = (dataUrl ?? '').trim()

  if (!value) {
    await setAdminAvatar(session.sub, null)
    revalidatePath('/admin')
    return { ok: true, message: 'Аватар удалён.' }
  }

  const isPreset = isDemonAvatarPreset(value)
  if (!isPreset) {
    if (value.length > MAX_AVATAR_DATAURL_LEN) {
      return {
        ok: false,
        message: 'Изображение слишком большое. Выберите файл поменьше.',
      }
    }
    if (!AVATAR_DATAURL_RE.test(value)) {
      return {
        ok: false,
        message: 'Неподдерживаемый формат. Загрузите PNG, JPEG или WebP.',
      }
    }
  }

  await setAdminAvatar(session.sub, value)
  revalidatePath('/admin')
  return { ok: true, message: 'Аватар обновлён.' }
}

/** Прочитать текущую аватарку администратора (для шапки/настроек). */
export async function getAdminAvatarAction(): Promise<string | null> {
  const session = await requireAdmin()
  return getAdminAvatar(session.sub)
}
