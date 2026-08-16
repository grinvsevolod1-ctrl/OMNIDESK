import type { AutoSpend, SiteCampaign } from '@/lib/god-sites'
import { autoDayFraction, dayCurveFraction } from '@/lib/god-sites-sim'

/**
 * Pure, presentation-free helpers shared by the site editor and its extracted
 * card components (campaign-card, recommendation editor). Kept framework-free
 * so they stay trivially testable and free of React coupling.
 */

export const CAMPAIGN_NUM_FIELDS: {
  key: 'cost' | 'shows' | 'clicks' | 'goals' | 'bounce' | 'revenue' | 'weeklyBudget'
  label: string
}[] = [
  { key: 'cost', label: 'Расход' },
  { key: 'shows', label: 'Показы' },
  { key: 'clicks', label: 'Клики' },
  { key: 'goals', label: 'Конверсии' },
  { key: 'bounce', label: 'Отказы, %' },
  { key: 'revenue', label: 'Доход' },
  { key: 'weeklyBudget', label: 'Нед. бюджет' },
]

export const CAMPAIGN_TEXT_FIELDS: {
  key: 'strategy' | 'platform' | 'regions' | 'type' | 'startDate' | 'endDate'
  label: string
  placeholder?: string
}[] = [
  { key: 'strategy', label: 'Стратегия' },
  { key: 'platform', label: 'Площадка', placeholder: 'Поиск и РСЯ' },
  { key: 'regions', label: 'Регионы' },
  { key: 'type', label: 'Тип кампании' },
  { key: 'startDate', label: 'Дата старта', placeholder: 'дд.мм.гггг' },
  { key: 'endDate', label: 'Дата окончания', placeholder: 'дд.мм.гггг или пусто' },
]

export function newCampaign(): SiteCampaign {
  return {
    id: String(100000000 + Math.floor(Math.random() * 900000000)),
    name: 'Новая кампания',
    status: 'stopped',
    cost: 0,
    shows: 0,
    clicks: 0,
    goals: 0,
    bounce: 0,
    revenue: 0,
    weeklyBudget: 0,
    strategy: '',
    platform: '',
    regions: '',
    type: '',
    startDate: '',
    endDate: '',
  }
}

export const nf = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 })

/**
 * Derived metrics exactly as the vitrine computes them (contract §7) — shown
 * read-only so the operator sees the resulting CTR/CPC/CPA while typing raw
 * numbers, instead of checking the live page after every save.
 */
export function derived(c: SiteCampaign): { label: string; value: string }[] {
  const ctr = c.shows > 0 ? (c.clicks / c.shows) * 100 : 0
  const cpc = c.clicks > 0 ? c.cost / c.clicks : 0
  const cpa = c.goals > 0 ? c.cost / c.goals : 0
  const cr = c.clicks > 0 ? (c.goals / c.clicks) * 100 : 0
  const drr = c.revenue > 0 ? (c.cost / c.revenue) * 100 : 0
  const roi = c.cost > 0 ? ((c.revenue - c.cost) / c.cost) * 100 : 0
  return [
    { label: 'CTR', value: `${nf.format(ctr)}%` },
    { label: 'CPC', value: nf.format(cpc) },
    { label: 'CPA', value: nf.format(cpa) },
    { label: 'CR', value: `${nf.format(cr)}%` },
    { label: 'ДРР', value: `${nf.format(drr)}%` },
    { label: 'ROI', value: `${nf.format(roi)}%` },
  ]
}

/**
 * "К этому часу скручено ~N%" preview — the SAME curve dispatch the server
 * uses (profile → smoothed S-curve, no profile → historical step curve), so
 * the preview can never silently drift from what the vitrine actually shows.
 */
export function previewDayFraction(auto: AutoSpend | undefined): number {
  const tz = auto?.tzOffsetHours ?? 3
  return auto?.profile
    ? dayCurveFraction(new Date(), tz, auto.profile, auto.smoothness ?? 0.6)
    : autoDayFraction(new Date(), tz)
}
