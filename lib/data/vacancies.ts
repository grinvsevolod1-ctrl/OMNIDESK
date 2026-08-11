/**
 * Справочник должностей (миграция 122). Никакого хардкода: базовый сид
 * («Курьер», «Водитель») задан миграцией, дальше пополняется из UI.
 */
import { query } from '../db'

export interface Vacancy {
  id: string
  name: string
  active: boolean
}

function normalizeVacancyName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

export async function listVacancies(): Promise<Vacancy[]> {
  const rows = await query<Vacancy>(
    `SELECT id, name, active FROM vacancies WHERE active ORDER BY name ASC`,
  )
  return rows
}

/** Добавить должность (идемпотентно по нормализованному имени). */
export async function addVacancy(raw: string): Promise<Vacancy> {
  const name = normalizeVacancyName(raw)
  if (!name) throw new Error('Укажите название должности')
  if (name.length > 80) throw new Error('Слишком длинное название должности')
  const rows = await query<Vacancy>(
    `INSERT INTO vacancies (name, name_norm)
     VALUES ($1, $2)
     ON CONFLICT (name_norm) DO UPDATE SET active = TRUE
     RETURNING id, name, active`,
    [name, name.toLowerCase()],
  )
  return rows[0]
}
