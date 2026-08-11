/**
 * Юнит-тесты единого поиска и мягкого удаления лидов (миграция 122):
 * разбор поискового запроса, whitelist inline-полей, SQL-форма
 * softDelete/restore/purge. БД замокана — проверяем запросы и параметры.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()
const txQueryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()

vi.mock('../db', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
  withTransaction: async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: (sql: string, params?: unknown[]) => txQueryMock(sql, params) }),
}))

import {
  isInlineLeadField,
  parseLeadSearch,
  purgeDeletedLeads,
  restoreLeadCard,
  softDeleteLeadCard,
  updateLeadCardField,
} from './lead-cards'

beforeEach(() => {
  queryMock.mockReset()
  txQueryMock.mockReset()
})

describe('parseLeadSearch', () => {
  it('распознаёт дату ДД.ММ.ГГГГ', () => {
    expect(parseLeadSearch('07.08.2026')).toEqual({
      day: '2026-08-07',
      text: '',
    })
  })

  it('распознаёт ISO-дату', () => {
    expect(parseLeadSearch('2026-08-07')).toEqual({
      day: '2026-08-07',
      text: '',
    })
  })

  it('обычный текст остаётся текстом', () => {
    expect(parseLeadSearch('  Иван   Петров ')).toEqual({
      day: null,
      text: 'Иван Петров',
    })
  })

  it('телефон и @username — текст', () => {
    expect(parseLeadSearch('+7 999 123-45-67').day).toBeNull()
    expect(parseLeadSearch('@ivan').text).toBe('@ivan')
  })
})

describe('isInlineLeadField', () => {
  it('разрешает только whitelisted поля', () => {
    for (const f of ['full_name', 'phone', 'telegram_username', 'city', 'address', 'vacancy']) {
      expect(isInlineLeadField(f)).toBe(true)
    }
    expect(isInlineLeadField('status')).toBe(false)
    expect(isInlineLeadField('deleted_at')).toBe(false)
    expect(isInlineLeadField('id; DROP TABLE lead_cards')).toBe(false)
  })
})

describe('softDeleteLeadCard', () => {
  it('требует причину минимум 3 символа', async () => {
    await expect(
      softDeleteLeadCard({ leadCardId: 'x', reason: 'ok', deletedById: null }),
    ).rejects.toThrow(/причин/i)
    expect(txQueryMock).not.toHaveBeenCalled()
  })

  it('помечает лид и пишет событие в историю', async () => {
    txQueryMock
      .mockResolvedValueOnce([{ id: 'lead-1' }]) // UPDATE
      .mockResolvedValueOnce([]) // history INSERT
    await softDeleteLeadCard({
      leadCardId: 'lead-1',
      reason: 'дубликат',
      deletedById: 'admin-1',
      deletedByName: 'Админ',
    })
    const updateSql = txQueryMock.mock.calls[0][0]
    expect(updateSql).toContain('deleted_at = now()')
    expect(updateSql).toContain('deleted_at IS NULL')
    expect(txQueryMock.mock.calls[0][1]).toEqual([
      'lead-1',
      'дубликат',
      'admin-1',
    ])
    const histSql = txQueryMock.mock.calls[1][0]
    expect(histSql).toContain('lead_status_history')
    expect(txQueryMock.mock.calls[1][1]?.[3]).toBe('deleted: дубликат')
  })

  it('падает если лид уже удалён', async () => {
    txQueryMock.mockResolvedValueOnce([])
    await expect(
      softDeleteLeadCard({
        leadCardId: 'gone',
        reason: 'причина',
        deletedById: null,
      }),
    ).rejects.toThrow(/не найден/i)
  })
})

describe('restoreLeadCard', () => {
  it('восстанавливает и пишет историю', async () => {
    txQueryMock
      .mockResolvedValueOnce([{ id: 'lead-1' }])
      .mockResolvedValueOnce([])
    await restoreLeadCard({ leadCardId: 'lead-1', restoredById: 'admin-1' })
    expect(txQueryMock.mock.calls[0][0]).toContain('deleted_at = NULL')
    expect(txQueryMock.mock.calls[1][0]).toContain("'restored'")
  })
})

describe('purgeDeletedLeads', () => {
  it('удаляет только старше N дней, параметризованно', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'a' }, { id: 'b' }])
    const n = await purgeDeletedLeads(30)
    expect(n).toBe(2)
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toContain('DELETE FROM lead_cards')
    expect(sql).toContain('deleted_at IS NOT NULL')
    expect(sql).toContain('make_interval')
    expect(params).toEqual([30])
  })

  it('не даёт отрицательный период', async () => {
    queryMock.mockResolvedValueOnce([])
    await purgeDeletedLeads(-5)
    expect(queryMock.mock.calls[0][1]).toEqual([1])
  })
})

describe('updateLeadCardField', () => {
  it('снимает @ у username', async () => {
    queryMock.mockResolvedValueOnce([{ id: 'lead-1' }])
    await updateLeadCardField({
      leadCardId: 'lead-1',
      field: 'telegram_username',
      value: '@ivan_petrov',
    })
    expect(queryMock.mock.calls[0][1]).toEqual(['lead-1', 'ivan_petrov'])
  })

  it('город проходит через справочник (rememberCity → INSERT cities)', async () => {
    queryMock
      .mockResolvedValueOnce([{ name: 'Москва' }]) // rememberCity
      .mockResolvedValueOnce([{ id: 'lead-1' }]) // UPDATE
    await updateLeadCardField({
      leadCardId: 'lead-1',
      field: 'city',
      value: 'москва',
    })
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO cities')
    expect(queryMock.mock.calls[1][1]).toEqual(['lead-1', 'Москва'])
  })

  it('отклоняет невалидное поле', async () => {
    await expect(
      updateLeadCardField({
        leadCardId: 'x',
        field: 'status' as never,
        value: 'hot',
      }),
    ).rejects.toThrow()
    expect(queryMock).not.toHaveBeenCalled()
  })
})
