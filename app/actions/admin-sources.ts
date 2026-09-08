'use server'

/**
 * Админ: источники трафика (миграция 145) — CRUD, назначение байера,
 * состав менеджеров. Источник работает всегда, окон дня нет. Всё под
 * requireAdmin.
 */
import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { listManagers } from '@/lib/data'
import {
  createTrafficSource,
  deleteTrafficSource,
  getSourceStats,
  getTrafficSourceById,
  listBuyers,
  listManagersOfSource,
  listTrafficSources,
  mapManagerSources,
  setSourceManagers,
  updateTrafficSource,
} from '@/lib/data/traffic-sources'
import { writeAudit } from '@/lib/data/audit'
import type { ActionResult } from '@/lib/types'

/** Admin: источники + справочники байеров и менеджеров (страница /admin/sources). */
export async function listSourcesAdminAction() {
  await requireAdmin()
  const [sources, buyers, managers, managerSources] = await Promise.all([
    listTrafficSources(),
    listBuyers(),
    listManagers(),
    mapManagerSources(),
  ])
  const [sourceManagers, stats] = await Promise.all([
    Promise.all(
      sources.map(async (s) => ({
        sourceId: s.id,
        managers: await listManagersOfSource(s.id),
      })),
    ),
    getSourceStats(sources.map((s) => s.id)),
  ])
  const bySource = new Map(sourceManagers.map((x) => [x.sourceId, x.managers]))
  return {
    sources: sources.map((s) => ({
      ...s,
      managers: (bySource.get(s.id) ?? []).map((m) => ({
        id: m.id,
        name: m.name,
      })),
      // Сегодня: написавших и переданных куратору.
      todayTotal: stats.get(s.id)?.todayTotal ?? 0,
      transferredToday: stats.get(s.id)?.transferredToday ?? 0,
    })),
    buyers: buyers.map((b) => ({ id: b.id, name: b.name, status: b.status })),
    allManagers: managers.map((m) => ({
      id: m.id,
      name: m.name,
      sourceId: managerSources.get(m.id)?.sourceId ?? null,
      sourceName: managerSources.get(m.id)?.sourceName ?? null,
    })),
  }
}

/** Admin: создать источник трафика. */
export async function createSourceAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin()
  const name = String(formData.get('name') ?? '').trim()
  const buyerId = String(formData.get('buyerId') ?? '').trim() || null
  const notes = String(formData.get('notes') ?? '').trim() || null

  if (!name) return { ok: false, message: 'Укажите название источника.' }

  try {
    const created = await createTrafficSource({
      name,
      buyerId,
      notes,
    })
    await writeAudit({
      actorRole: 'admin',
      actorLabel: 'Administrator',
      action: 'traffic_source.create',
      entityType: 'traffic_source',
      entityId: created.id,
      details: { name, buyerId },
    })
    revalidatePath('/admin/sources')
    revalidatePath('/admin/buyers')
    return { ok: true, message: `Источник «${name}» создан.` }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Не удалось создать источник.',
    }
  }
}

/** Admin: обновить источник (название, байер, заметки, активность). */
export async function updateSourceAction(
  formData: FormData,
): Promise<ActionResult> {
  await requireAdmin()
  const id = String(formData.get('id') ?? '').trim()
  const name = String(formData.get('name') ?? '').trim()
  const buyerId = String(formData.get('buyerId') ?? '').trim() || null
  const notes = String(formData.get('notes') ?? '').trim() || null
  const isActive = String(formData.get('isActive') ?? 'true') === 'true'

  if (!id) return { ok: false, message: 'Источник не найден.' }
  if (!name) return { ok: false, message: 'Укажите название источника.' }

  const existing = await getTrafficSourceById(id)
  if (!existing) return { ok: false, message: 'Источник не найден.' }

  try {
    await updateTrafficSource({
      id,
      name,
      buyerId,
      notes,
      isActive,
    })
    await writeAudit({
      actorRole: 'admin',
      actorLabel: 'Administrator',
      action: 'traffic_source.update',
      entityType: 'traffic_source',
      entityId: id,
      details: { name, buyerId, isActive },
    })
    revalidatePath('/admin/sources')
    revalidatePath('/admin/buyers')
    return { ok: true, message: 'Источник обновлён.' }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Не удалось обновить источник.',
    }
  }
}

/** Admin: полная замена состава менеджеров источника. */
export async function setSourceManagersAction(
  sourceId: string,
  managerIds: string[],
): Promise<ActionResult> {
  await requireAdmin()
  const source = await getTrafficSourceById(sourceId)
  if (!source) return { ok: false, message: 'Источник не найден.' }
  await setSourceManagers(sourceId, managerIds)
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'traffic_source.managers_update',
    entityType: 'traffic_source',
    entityId: sourceId,
    details: { name: source.name, managerIds },
  })
  revalidatePath('/admin/sources')
  return { ok: true, message: 'Состав менеджеров обновлён.' }
}

/** Admin: удалить источник (привязки менеджеров и атрибуция лидов обнуляются). */
export async function deleteSourceAction(
  sourceId: string,
): Promise<ActionResult> {
  await requireAdmin()
  const source = await getTrafficSourceById(sourceId)
  if (!source) return { ok: false, message: 'Источник не найден.' }
  await deleteTrafficSource(sourceId)
  await writeAudit({
    actorRole: 'admin',
    actorLabel: 'Administrator',
    action: 'traffic_source.delete',
    entityType: 'traffic_source',
    entityId: sourceId,
    details: { name: source.name },
  })
  revalidatePath('/admin/sources')
  revalidatePath('/admin/buyers')
  return { ok: true, message: `Источник «${source.name}» удалён.` }
}
