import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The local command layer must NEVER swallow anything it can't answer
 * deterministically — a false positive silently hides the LLM's judgement
 * (e.g. «создай менеджера» rendered as a manager list). These tests pin the
 * matcher's precision with all data-access functions mocked.
 */

vi.mock('@/lib/data', () => ({
  getAdminStats: vi.fn(async () => ({ managers: { total: 1 } })),
  getConversationAdmin: vi.fn(async (id: string) =>
    id === 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
      ? {
          id,
          contactName: 'Клиент',
          contactHandle: '@client',
          managerName: 'Иван',
          channelType: 'telegram',
        }
      : null,
  ),
  getManagerPerformance: vi.fn(async () => []),
  getProxyAnalytics: vi.fn(async () => ({})),
  listAdminChannels: vi.fn(async () => []),
  listAllProxies: vi.fn(async () => []),
  listConversationsAdmin: vi.fn(async () => []),
  listManagerActivity: vi.fn(async () => []),
  listManagers: vi.fn(async () => [
    { id: 'm1', name: 'Иван Петров', email: 'ivan@x.ru', status: 'active' },
  ]),
  listMessagesAdmin: vi.fn(async () => []),
}))
vi.mock('@/lib/data/dictionaries', () => ({
  getDictionaries: vi.fn(async () => ({
    channelTypes: {},
    accountStatuses: {},
    proxyStatuses: {},
    leadStatuses: {},
  })),
}))
vi.mock('@/lib/data/ai-directives', () => ({
  listDirectives: vi.fn(async () => []),
}))
vi.mock('@/lib/data/ai-assist', () => ({
  listKnowledge: vi.fn(async () => []),
}))

import { tryLocalCommand } from './local-commands'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('tryLocalCommand — recognized commands (no gateway needed)', () => {
  it.each([
    ['покажи сводку', 'stats'],
    ['Статистика', 'stats'],
    ['покажи менеджеров', 'managers'],
    ['список менеджеров', 'managers'],
    ['покажи каналы', 'channels'],
    ['прокси', 'proxies'],
    ['покажи директивы', 'directives'],
    ['база знаний', 'knowledge'],
  ])('«%s» → %s view', async (text, kind) => {
    const res = await tryLocalCommand(text)
    expect(res).not.toBeNull()
    expect(res!.views[0]?.kind).toBe(kind)
  })

  it('answers manager activity with period detection', async () => {
    const res = await tryLocalCommand('активность менеджеров за неделю')
    expect(res?.views[0]?.kind).toBe('manager_activity')
    expect(res?.views[0]?.title).toContain('неделю')
  })

  it('answers unanswered-dialog queries', async () => {
    const res = await tryLocalCommand('покажи диалоги без ответа')
    expect(res?.views[0]?.kind).toBe('dialogs')
    expect(res?.views[0]?.title).toBe('Диалоги без ответа')
  })

  it('resolves «диалоги менеджера <имя>» locally (clickable row command)', async () => {
    const res = await tryLocalCommand('Покажи диалоги менеджера Иван Петров')
    expect(res?.views[0]?.kind).toBe('dialogs')
    expect(res?.views[0]?.title).toContain('Иван Петров')
  })

  it('opens a dialog transcript by id (clickable row command)', async () => {
    const res = await tryLocalCommand(
      'Покажи переписку с «Клиент» (диалог aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee)',
    )
    expect(res?.views[0]?.kind).toBe('messages')
  })

  it('handles navigation («открой раздел учёт»)', async () => {
    const res = await tryLocalCommand('открой раздел учёт')
    expect(res?.openSection).toBe('finance')
    expect(res?.views).toHaveLength(0)
  })

  it('answers the capabilities question without the gateway', async () => {
    const res = await tryLocalCommand('что ты умеешь?')
    expect(res?.reply).toContain('панел')
  })
})

describe('tryLocalCommand — must defer to the LLM (returns null)', () => {
  it.each([
    'создай менеджера Ивана',
    'заблокируй менеджера Ивана',
    'удали менеджера m1',
    'ответь клиенту в диалоге что мы перезвоним',
    'передай все диалоги без ответа менеджеру Х', // mutation, not a read
    'сравни менеджеров за неделю и месяц',
    'почему упала конверсия?',
    'добавь правило: на вопрос о цене отвечай уклончиво',
    'сколько мы потратили на рекламу в марте',
  ])('«%s» → null', async (text) => {
    expect(await tryLocalCommand(text)).toBeNull()
  })

  it('defers unknown manager names to the LLM', async () => {
    expect(
      await tryLocalCommand('покажи диалоги менеджера Несуществующий'),
    ).toBeNull()
  })

  it('defers unknown dialog ids to the LLM', async () => {
    expect(
      await tryLocalCommand('покажи переписку (диалог 99999999-0000-0000-0000-000000000000)'),
    ).toBeNull()
  })

  it('returns null on empty and oversized input', async () => {
    expect(await tryLocalCommand('')).toBeNull()
    expect(await tryLocalCommand('покажи сводку '.repeat(30))).toBeNull()
  })

  it('fails open when the DB layer throws', async () => {
    const { listManagers } = await import('@/lib/data')
    vi.mocked(listManagers).mockRejectedValueOnce(new Error('db down'))
    expect(await tryLocalCommand('покажи менеджеров')).toBeNull()
  })
})
