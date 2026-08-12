'use server'

/**
 * Выгрузка лидов в Excel (.xlsx, exceljs). Выгружается ТЕКУЩАЯ выборка
 * с фильтрами таблицы (или вся база при пустых фильтрах), батчами по 500 —
 * рассчитано на 1500+ лидов без нагрузки на память.
 */
import { requireAdmin, requireCurator, requireManager } from '@/lib/auth'
import {
  listAllTransferredLeads,
  listArchivedLeadsForCurator,
  listLeadCardsForCurator,
  type AllLeadsFilter,
  type LeadCard,
} from '@/lib/data/lead-cards'
import {
  listLeadCardsForManager,
  type ManagerLeadFilterStatus,
} from '@/lib/data/lead-stats'
import { isLeadStatus, LEAD_STATUS_LABELS } from '@/lib/lead-status'

const BATCH = 500
const MAX_ROWS = 20000

export interface ExportLeadsResult {
  ok: boolean
  message?: string
  /** base64-содержимое .xlsx */
  base64?: string
  fileName?: string
  rows?: number
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

export async function exportLeadsExcelAction(filter: {
  curatorId?: string | null
  status?: string | null
  search?: string | null
  archivedOnly?: boolean
  orphanedOnly?: boolean
  from?: string | null
  to?: string | null
  sort?: 'newest' | 'oldest'
}): Promise<ExportLeadsResult> {
  await requireAdmin()
  try {
    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Лиды', {
      views: [{ state: 'frozen', ySplit: 1 }],
    })
    ws.columns = [
      { header: 'Дата передачи', key: 'date', width: 17 },
      { header: 'ФИО', key: 'name', width: 28 },
      { header: 'Телефон', key: 'phone', width: 17 },
      { header: 'Telegram', key: 'tg', width: 20 },
      { header: 'Город', key: 'city', width: 18 },
      { header: 'Регион', key: 'region', width: 26 },
      { header: 'Должность', key: 'vacancy', width: 16 },
      { header: 'Статус', key: 'status', width: 18 },
      { header: 'Менеджер по кадрам', key: 'curator', width: 24 },
      { header: 'Менеджер', key: 'manager', width: 22 },
      { header: 'Адрес', key: 'address', width: 30 },
    ]
    ws.getRow(1).font = { bold: true }

    const base: AllLeadsFilter = {
      curatorId: filter.curatorId ?? null,
      status:
        filter.status === 'none'
          ? 'none'
          : isLeadStatus(filter.status)
            ? filter.status
            : null,
      search: filter.search?.slice(0, 200) ?? null,
      archivedOnly: Boolean(filter.archivedOnly),
      orphanedOnly: Boolean(filter.orphanedOnly),
      from: filter.from ?? null,
      to: filter.to ?? null,
      sort: filter.sort === 'oldest' ? 'oldest' : 'newest',
    }

    let offset = 0
    let rows = 0
    for (;;) {
      const { leads } = await listAllTransferredLeads({
        ...base,
        limit: BATCH,
        offset,
      })
      for (const l of leads) {
        ws.addRow({
          date: fmtDate(l.transferredAt),
          name: l.fullName,
          phone: l.phone,
          tg: l.telegramUsername ? `@${l.telegramUsername}` : '',
          city: l.city,
          region: l.region ?? '',
          vacancy: l.vacancy,
          status: l.status ? LEAD_STATUS_LABELS[l.status] : 'Без статуса',
          curator: l.curatorName ?? '',
          manager: l.managerName ?? '',
          address: l.address,
        })
      }
      rows += leads.length
      offset += BATCH
      if (leads.length < BATCH || rows >= MAX_ROWS) break
    }

    const buf = await wb.xlsx.writeBuffer()
    const day = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
    })
      .format(new Date())
      .replace(/\./g, '-')
    return {
      ok: true,
      base64: Buffer.from(buf).toString('base64'),
      fileName: `лиды-${day}.xlsx`,
      rows,
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Ошибка выгрузки',
    }
  }
}

/**
 * Выгрузка «Моих лидов» обычного менеджера — та же книга, что у остальных
 * ролей, но только собственные лиды с учётом текущих фильтров (период +
 * статус) и без колонки «Менеджер» (она всегда = самому себе). Вместо неё —
 * «Менеджер по кадрам», кому передан лид.
 */
export async function exportManagerLeadsExcelAction(input: {
  from?: string | null
  to?: string | null
  status?: ManagerLeadFilterStatus
}): Promise<ExportLeadsResult> {
  const session = await requireManager()
  try {
    const { leads } = await listLeadCardsForManager(session.sub, {
      from: input.from ?? null,
      to: input.to ?? null,
      status: input.status ?? null,
      limit: MAX_ROWS,
      offset: 0,
    })

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Мои лиды', {
      views: [{ state: 'frozen', ySplit: 1 }],
    })
    ws.columns = [
      { header: 'Дата создания', key: 'date', width: 17 },
      { header: 'ФИО', key: 'name', width: 28 },
      { header: 'Телефон', key: 'phone', width: 17 },
      { header: 'Telegram', key: 'tg', width: 20 },
      { header: 'Город', key: 'city', width: 18 },
      { header: 'Должность', key: 'vacancy', width: 16 },
      { header: 'Статус', key: 'status', width: 18 },
      { header: 'Менеджер по кадрам', key: 'curator', width: 24 },
      { header: 'Адрес', key: 'address', width: 30 },
    ]
    ws.getRow(1).font = { bold: true }

    for (const l of leads) {
      ws.addRow({
        date: fmtDate(l.createdAt),
        name: l.fullName,
        phone: l.phone,
        tg: l.telegramUsername ? `@${l.telegramUsername}` : '',
        city: l.city,
        vacancy: l.vacancy,
        status: l.status ? LEAD_STATUS_LABELS[l.status] : 'Без статуса',
        curator: l.curatorName ?? '',
        address: l.address,
      })
    }

    const buf = await wb.xlsx.writeBuffer()
    const day = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
    })
      .format(new Date())
      .replace(/\./g, '-')
    return {
      ok: true,
      base64: Buffer.from(buf).toString('base64'),
      fileName: `мои-лиды-${day}.xlsx`,
      rows: leads.length,
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Ошибка выгрузки',
    }
  }
}

/**
 * Выгрузка «Моих лидов» менеджера по кадрам — та же книга, что у админа,
 * но только собственные лиды (активные или архив) и без колонки «Менеджер
 * по кадрам» (она всегда = самому сотруднику). Объём небольшой (сотни),
 * поэтому без батчей — одним списком.
 */
export async function exportMyLeadsExcelAction(input: {
  archived?: boolean
}): Promise<ExportLeadsResult> {
  const session = await requireCurator()
  try {
    const leads: LeadCard[] = input.archived
      ? await listArchivedLeadsForCurator(session.sub)
      : await listLeadCardsForCurator(session.sub)

    const ExcelJS = (await import('exceljs')).default
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Мои лиды', {
      views: [{ state: 'frozen', ySplit: 1 }],
    })
    ws.columns = [
      { header: 'Дата передачи', key: 'date', width: 17 },
      { header: 'ФИО', key: 'name', width: 28 },
      { header: 'Телефон', key: 'phone', width: 17 },
      { header: 'Telegram', key: 'tg', width: 20 },
      { header: 'Город', key: 'city', width: 18 },
      { header: 'Должность', key: 'vacancy', width: 16 },
      { header: 'Статус', key: 'status', width: 18 },
      { header: 'Менеджер', key: 'manager', width: 22 },
      { header: 'Адрес', key: 'address', width: 30 },
    ]
    ws.getRow(1).font = { bold: true }

    for (const l of leads.slice(0, MAX_ROWS)) {
      ws.addRow({
        date: fmtDate(l.transferredAt),
        name: l.fullName,
        phone: l.phone,
        tg: l.telegramUsername ? `@${l.telegramUsername}` : '',
        city: l.city,
        vacancy: l.vacancy,
        status: l.status ? LEAD_STATUS_LABELS[l.status] : 'Без статуса',
        manager: l.managerName ?? '',
        address: l.address,
      })
    }

    const buf = await wb.xlsx.writeBuffer()
    const day = new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
    })
      .format(new Date())
      .replace(/\./g, '-')
    return {
      ok: true,
      base64: Buffer.from(buf).toString('base64'),
      fileName: `мои-лиды${input.archived ? '-архив' : ''}-${day}.xlsx`,
      rows: Math.min(leads.length, MAX_ROWS),
    }
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : 'Ошибка выгрузки',
    }
  }
}
