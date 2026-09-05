/**
 * Юнит-тесты раздела «Чаты» куратора (миграция 151):
 *  1. recordTransfer вслед за передачей лида линкует его ДИАЛОГ к тому же
 *     куратору (единый chokepoint) и ставит ai_paused.
 *  2. Читающие функции куратора скоупятся строго по curator_id (анти-IDOR).
 * db замокан — проверяем именно передаваемые в SQL параметры и WHERE-скоуп.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const queryMock = vi.fn<(sql: string, params?: unknown[]) => Promise<unknown[]>>()

vi.mock('../db', () => ({
  query: (sql: string, params?: unknown[]) => queryMock(sql, params),
  withTransaction: vi.fn(),
}))

const sendPushToManagerMock =
  vi.fn<(managerId: string, payload: unknown) => Promise<unknown>>()

vi.mock('../push', () => ({
  sendPushToManager: (managerId: string, payload: unknown) =>
    sendPushToManagerMock(managerId, payload),
}))

import { notifyCuratorTransferred, recordTransfer } from './lead-history'
import {
  getConversationForCurator,
  listMessagesForCurator,
} from './curator-conversations'
import { isConversationAiLed } from './ai-assist-enrollment'

beforeEach(() => {
  queryMock.mockReset()
  queryMock.mockResolvedValue([])
  sendPushToManagerMock.mockReset()
  sendPushToManagerMock.mockResolvedValue({ sent: 1, pruned: 0 })
})

describe('notifyCuratorTransferred (push при передаче)', () => {
  it('шлёт куратору push с conversationId и replyRole=curator', async () => {
    queryMock.mockResolvedValueOnce([
      {
        conversation_id: 'conv-7',
        contact_name: 'Иван Петров',
        contact_handle: '@ivan',
        channel_type: 'telegram',
      },
    ])

    await notifyCuratorTransferred('lead-1', 'cur-9')

    expect(sendPushToManagerMock).toHaveBeenCalledTimes(1)
    const [managerId, payload] = sendPushToManagerMock.mock.calls[0]
    expect(managerId).toBe('cur-9')
    expect(payload).toMatchObject({
      conversationId: 'conv-7',
      replyRole: 'curator',
      url: '/curator/chats',
      tag: 'conv:conv-7',
    })
    // Тело несёт имя контакта и канал.
    expect(String((payload as { body: string }).body)).toContain('Иван Петров')
    expect(String((payload as { body: string }).body)).toContain('Telegram')
  })

  it('лид без диалога (conversation_id NULL) не шлёт push', async () => {
    queryMock.mockResolvedValueOnce([]) // JOIN conversations ничего не вернул
    await notifyCuratorTransferred('lead-2', 'cur-9')
    expect(sendPushToManagerMock).not.toHaveBeenCalled()
  })

  it('сбой доставки не пробрасывается (best-effort)', async () => {
    queryMock.mockResolvedValueOnce([
      { conversation_id: 'conv-8', contact_name: null, contact_handle: null, channel_type: null },
    ])
    sendPushToManagerMock.mockRejectedValueOnce(new Error('push down'))
    await expect(
      notifyCuratorTransferred('lead-3', 'cur-9'),
    ).resolves.toBeUndefined()
  })
})

describe('recordTransfer → conversation link', () => {
  it('links the lead conversation to the curator and pauses AI', async () => {
    // Вне транзакции recordTransfer использует общий query() (best-effort).
    await recordTransfer({
      leadCardId: 'lead-1',
      fromCuratorId: null,
      toCuratorId: 'cur-9',
      initiatedById: 'mgr-1',
      initiatedByRole: 'manager',
    })

    // Второй запрос — UPDATE conversations ... SET curator_id.
    const updateCall = queryMock.mock.calls.find((c) =>
      /UPDATE conversations/i.test(String(c[0])),
    )
    expect(updateCall).toBeDefined()
    const [sql, params] = updateCall!
    expect(sql).toMatch(/curator_id = \$2/)
    expect(sql).toMatch(/transferred_to_curator_at = now\(\)/)
    expect(sql).toMatch(/ai_paused = true/)
    // Линкуем только диалог ЭТОГО лида.
    expect(sql).toMatch(/lc\.id = \$1/)
    expect(sql).toMatch(/lc\.conversation_id = c\.id/)
    expect(params).toEqual(['lead-1', 'cur-9'])
  })
})

describe('curator reads are scoped by curator_id', () => {
  it('getConversationForCurator filters on curator_id', async () => {
    queryMock.mockResolvedValueOnce([])
    await getConversationForCurator('conv-1', 'cur-9')
    const [sql, params] = queryMock.mock.calls[0]
    expect(sql).toMatch(/curator_id = \$2/)
    expect(params).toEqual(['conv-1', 'cur-9'])
  })

  it('listMessagesForCurator refuses cross-curator access via WHERE scope', async () => {
    queryMock.mockResolvedValueOnce([])
    await listMessagesForCurator('conv-1', 'cur-9')
    const [sql, params] = queryMock.mock.calls[0]
    // Сообщения тянем только если диалог принадлежит этому куратору.
    expect(sql).toMatch(/curator_id = \$2/)
    expect(params).toContain('conv-1')
    expect(params).toContain('cur-9')
  })
})

describe('isConversationAiLed gate (панель)', () => {
  it('AI перестаёт вести диалог, переданный куратору (curator_id IS NULL)', async () => {
    // Гейт заложен в сам SQL — проверяем, что формула содержит curator_id.
    queryMock.mockResolvedValueOnce([{ led: false }])
    const led = await isConversationAiLed('conv-1')
    const [sql] = queryMock.mock.calls[0]
    expect(sql).toMatch(/c\.curator_id IS NULL/)
    expect(led).toBe(false)
  })

  it('AI ведёт диалог без куратора', async () => {
    queryMock.mockResolvedValueOnce([{ led: true }])
    expect(await isConversationAiLed('conv-2')).toBe(true)
  })
})
