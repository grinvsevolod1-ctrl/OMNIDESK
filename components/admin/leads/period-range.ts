import { mskDayKey } from '@/lib/time'

/**
 * Размер страницы списка лидов. Живёт в этом нейтральном модуле (без
 * 'use client'), чтобы серверная страница /admin/leads могла импортировать
 * константу напрямую — из клиентского use-leads-data.ts это невозможно.
 */
export const LEADS_PAGE_SIZE = 20

/** Пресеты периода для статистики и фильтрации списка лидов. */
export type PeriodPreset = 'all' | 'today' | '7d' | '30d' | 'day' | 'range'

/** Сдвиг дня (YYYY-MM-DD) на N суток в UTC-пространстве ключа дня. */
export function shiftDay(day: string, deltaDays: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + deltaDays)
  return d.toISOString().slice(0, 10)
}

/** Resolve a preset into an inclusive MSK from/to pair (nulls = no limit). */
export function presetRange(
  preset: PeriodPreset,
  day: string,
  from: string,
  to: string,
): { from: string | null; to: string | null } {
  const today = mskDayKey(new Date())
  switch (preset) {
    case 'all':
      return { from: null, to: null }
    case 'today':
      return { from: today, to: today }
    case '7d':
      return { from: shiftDay(today, -6), to: today }
    case '30d':
      return { from: shiftDay(today, -29), to: today }
    case 'day':
      return { from: day, to: day }
    case 'range':
      return { from, to }
  }
}
