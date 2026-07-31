/**
 * Client-SAFE content defaults for the client simulator.
 *
 * This module deliberately imports ONLY types (which are erased at build time),
 * so it can be imported from client components (e.g. the admin content panel)
 * without dragging the server-only chain generate.ts → store → lib/db (pg) into
 * the browser bundle. Keep it free of any runtime imports from ./store, ./db,
 * ./learning, or the `ai` package.
 */
import type { SimContentConfig } from './types'

/** Fully-resolved web-form opener config with no gaps. */
export interface ResolvedWFConfig {
  siteName: string
  vacancies: Array<{ title: string; salary: string; city?: string; format?: string }>
  cities: string[]
  scheduleTypes: string[]
  matchPctMin: number
  matchPctMax: number
}

/**
 * Fallback used when no DB config is present yet.
 *
 * These are the ACTUAL Thunders Group site vacancies (lib/data.ts VACANCIES on
 * the ai-job-matcher branch), each with its real bound city + salary + format.
 * The site's AI matcher always sends a lead built from one of these exact rows
 * (title, vacancy.city, vacancy.salary, vacancy.format), so binding them here
 * makes every simulated lead structurally identical to a real one — a manager
 * cross-checking against the vacancy list can't find an impossible combination.
 * `match` is 94-98 to mirror the site's `94 + rand(0..4)`.
 */
export const SIM_CONTENT_DEFAULTS: ResolvedWFConfig = {
  siteName: 'Thunders Group',
  vacancies: [
    { title: 'Frontend-разработчик (React)',     salary: 'от 180 000 ₽',    city: 'Москва',          format: 'Гибрид' },
    { title: 'Специалист технической поддержки', salary: 'от 90 000 ₽',     city: 'Санкт-Петербург', format: 'Удалённо' },
    { title: 'Аналитик данных',                  salary: 'от 140 000 ₽',    city: 'Казань',          format: 'Офис' },
    { title: 'Кладовщик-комплектовщик',          salary: 'от 75 000 ₽',     city: 'Екатеринбург',    format: 'Сменный график' },
    { title: 'Водитель категории C',             salary: 'от 95 000 ₽',     city: 'Краснодар',       format: 'Полный день' },
    { title: 'Менеджер по продажам',             salary: 'от 70 000 ₽ + %', city: 'Новосибирск',     format: 'Офис' },
    { title: 'Оператор колл-центра',             salary: 'от 60 000 ₽',     city: 'Ростов-на-Дону',  format: 'Удалённо' },
    { title: 'Оператор производственной линии',  salary: 'от 80 000 ₽',     city: 'Самара',          format: 'Сменный график' },
    { title: 'Мастер участка',                   salary: 'от 110 000 ₽',    city: 'Нижний Новгород', format: 'Полный день' },
    { title: 'Бухгалтер на участок',             salary: 'от 120 000 ₽',    city: 'Москва',          format: 'Гибрид' },
    { title: 'HR-менеджер',                      salary: 'от 100 000 ₽',    city: 'Санкт-Петербург', format: 'Офис' },
    { title: 'Специалист клиентского сервиса',   salary: 'от 65 000 ₽',     city: 'Уфа',             format: 'Офис' },
  ],
  cities: [
    'Москва', 'Санкт-Петербург', 'Екатеринбург', 'Новосибирск', 'Казань',
    'Нижний Новгород', 'Краснодар', 'Ростов-на-Дону', 'Самара', 'Уфа',
  ],
  scheduleTypes: ['Гибрид', 'Удалённо', 'Офис', 'Сменный график', 'Полный день'],
  matchPctMin: 94,
  matchPctMax: 98,
}

/**
 * Merge DB-side SimContentConfig (any fields can be null/undefined) with
 * SIM_CONTENT_DEFAULTS to produce a fully-resolved config with no gaps.
 */
export function resolveWFConfig(cfg: SimContentConfig | null | undefined): ResolvedWFConfig {
  const d = SIM_CONTENT_DEFAULTS
  if (!cfg) return d
  return {
    siteName:      cfg.siteName ?? d.siteName,
    vacancies:     cfg.vacancies && cfg.vacancies.length > 0 ? cfg.vacancies : d.vacancies,
    cities:        cfg.cities && cfg.cities.length > 0 ? cfg.cities : d.cities,
    scheduleTypes: cfg.scheduleTypes && cfg.scheduleTypes.length > 0 ? cfg.scheduleTypes : d.scheduleTypes,
    matchPctMin:   cfg.matchPctMin ?? d.matchPctMin,
    matchPctMax:   cfg.matchPctMax ?? d.matchPctMax,
  }
}
