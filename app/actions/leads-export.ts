'use server'

/**
 * Выгрузка лидов в Excel (.xlsx, exceljs). Выгружается ТЕКУЩАЯ выборка
 * с фильтрами таблицы (или вся база при пустых фильтрах), батчами по 500 —
 * рассчитано на 1500+ лидов без нагрузки на память.
 */
import { requireAdmin } from '@/lib/auth'
import {
  listAllTransferredLeads,
  type AllLeadsFilter,
} from '@/lib/data/lead-cards'
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
