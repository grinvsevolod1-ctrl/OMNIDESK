/**
 * Раздел «Диалоги» руководителя: все чтения скоупятся по кураторам ЕГО
 * команд (managers.team_id → teams.head_id), фильтр по куратору — только
 * пересечением со скоупом, и в модуле нет ни одной пишущей функции (этап 1 —
 * только просмотр). db замокан — проверяем SQL и параметры.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()

vi.mock('../db', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
  withTransaction: vi.fn(),
}))

import * as headConversations from './head-conversations'
import { listAllMessagesForExport, EXPORT_MESSAGE_CAP } from './dialog-export'

const {
  getConversationForHead,
  getMessageOwnerForHead,
  listConversationsForHead,
  listMessagesBeforeForHead,
  listMessagesForConversationsHead,
  listMessagesForHead,
} = headConversations

const SCOPE = /c\.curator_id IN \(SELECT m\.id FROM managers m[\s\S]*teams t WHERE t\.head_id = \$1/

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue([])
})

describe('head reads are scoped to the curators of the head’s teams', () => {
  it('listConversationsForHead: скоуп + необязательный фильтр по куратору', async () => {
    await listConversationsForHead('head-1')
    let [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(SCOPE)
    expect(sql).toMatch(/\$2::uuid IS NULL OR c\.curator_id = \$2::uuid/)
    expect(params?.[0]).toBe('head-1')
    expect(params?.[1]).toBeNull()

    queryMock.mockClear()
    await listConversationsForHead('head-1', 'cur-5')
    ;[sql, params] = queryMock.mock.calls[0]
    expect(params?.[1]).toBe('cur-5')
    // Фильтр по куратору НЕ заменяет скоуп — оба условия в одном WHERE.
    expect(sql).toMatch(SCOPE)
  })

  it('getConversationForHead / listMessagesForHead / listMessagesBeforeForHead', async () => {
    await getConversationForHead('conv-1', 'head-1')
    await listMessagesForHead('conv-1', 'head-1')
    await listMessagesBeforeForHead('conv-1', 'head-1', '2026-01-01T00:00:00.000Z', 50)
    for (const [sql, params] of queryMock.mock.calls) {
      expect(sql).toMatch(SCOPE)
      expect(params?.[0]).toBe('head-1')
      expect(params?.[1]).toBe('conv-1')
    }
  })

  it('listMessagesForConversationsHead: батч под тем же скоупом, пустой вход — без запроса', async () => {
    expect(await listMessagesForConversationsHead([], 'head-1')).toEqual({})
    expect(queryMock).not.toHaveBeenCalled()
    await listMessagesForConversationsHead(['a', 'b'], 'head-1')
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(SCOPE)
    expect(params).toEqual(['head-1', ['a', 'b'], 30])
  })

  it('getMessageOwnerForHead: медиа только из диалогов кураторов команды', async () => {
    expect(await getMessageOwnerForHead('msg-1', 'head-1')).toBeNull()
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(SCOPE)
    expect(sql).toMatch(/m\.id = \$2/)
    expect(params).toEqual(['head-1', 'msg-1'])
  })

  it('модуль не экспортирует пишущих функций', () => {
    for (const name of Object.keys(headConversations)) {
      expect(name).not.toMatch(/^(set|mark|update|delete|add|send|link|unlink)/)
    }
  })
})

describe('listAllMessagesForExport', () => {
  it('читает всю историю одного диалога в хронологии и помечает обрезку', async () => {
    const rows = Array.from({ length: EXPORT_MESSAGE_CAP + 1 }, (_, i) => ({
      id: `m${i}`,
      conversation_id: 'conv-1',
      direction: 'in',
      body: String(i),
      author: 'x',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, EXPORT_MESSAGE_CAP - i)).toISOString(),
    }))
    queryMock.mockResolvedValueOnce(rows)
    const res = await listAllMessagesForExport('conv-1')
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/WHERE m\.conversation_id = \$1/)
    expect(sql).toMatch(/ORDER BY m\.created_at DESC, m\.id DESC/)
    expect(params).toEqual(['conv-1', EXPORT_MESSAGE_CAP + 1])
    expect(res.truncated).toBe(true)
    expect(res.messages).toHaveLength(EXPORT_MESSAGE_CAP)
    // Развёрнуто в хронологию: первый элемент — самый старый из взятых.
    expect(
      new Date(res.messages[0].createdAt).getTime(),
    ).toBeLessThan(new Date(res.messages.at(-1)!.createdAt).getTime())
  })
})
