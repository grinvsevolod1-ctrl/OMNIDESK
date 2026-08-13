/**
 * Tests for the shared AI-lead orchestrator: single-flight claiming, the
 * dirty-flag re-run (a second inbound arriving mid-generation must be
 * ANSWERED, not silently dropped), re-run bounding, and error containment.
 */
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

vi.mock('./manager-brain', () => ({
  assessLeadReady: vi.fn(async () => false),
  clientShowsReadinessSignal: vi.fn(() => false),
  detectEscalation: vi.fn(async () => ({ escalate: false, reason: '' })),
  extractClientMemory: vi.fn(async () => null),
  generateManagerReply: vi.fn(async () => 'ответ'),
}))

import { runAiLead, type AiLeadRunDeps } from './ai-lead-run'
import { detectEscalation, generateManagerReply } from './manager-brain'

interface TestDeps extends AiLeadRunDeps {
  sends: string[]
  assembleCalls: number
  errors: unknown[]
}

function makeDeps(overrides?: Partial<AiLeadRunDeps>): TestDeps {
  const deps: TestDeps = {
    sends: [],
    assembleCalls: 0,
    errors: [],
    log: () => {},
    logAi: () => {},
    isConversationAiLed: async () => true,
    getConfig: async () => ({
      enabled: true,
      persona: 'персона',
      tone: 'дружелюбно',
      playbook: [],
      aggressiveness: 2,
      model: 'openai/gpt-4.1',
      temperature: 0.7,
      maxTokens: 400,
    }),
    assembleInput: async () => {
      deps.assembleCalls += 1
      return {
        lessons: [],
        corrections: [],
        directives: [],
        history: [{ role: 'client' as const, body: 'привет' }],
        memory: '',
        knowledge: '',
      }
    },
    applyExperiment: async (base) => ({ settings: base, extraDirectives: [] }),
    markAiHandoffToHuman: async () => true,
    saveConversationAiMemory: async () => {},
    send: async (_id, reply) => {
      deps.sends.push(reply)
    },
    inboundLogMessage: 'входящее',
    onError: (err) => {
      deps.errors.push(err)
    },
    onBackgroundError: () => {},
    ...overrides,
  }
  return deps
}

const tick = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  vi.clearAllMocks()
  ;(generateManagerReply as Mock).mockImplementation(async () => 'ответ')
  ;(detectEscalation as Mock).mockImplementation(async () => ({
    escalate: false,
    reason: '',
  }))
})

describe('runAiLead', () => {
  it('handles a single inbound: one assemble, one send', async () => {
    const deps = makeDeps()
    expect(await runAiLead('conv-1', deps)).toBe(true)
    expect(deps.assembleCalls).toBe(1)
    expect(deps.sends).toEqual(['ответ'])
  })

  it('re-runs with FRESH history when a second inbound arrives mid-generation (the message is answered, not dropped)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    ;(generateManagerReply as Mock)
      .mockImplementationOnce(async () => {
        await gate
        return 'первый ответ'
      })
      .mockImplementationOnce(async () => 'второй ответ')

    const deps = makeDeps()
    const first = runAiLead('conv-1', deps)
    await tick() // let the first pass reach generation and hold the flight

    // Second inbound while composing: absorbed into the flight (handled).
    expect(await runAiLead('conv-1', deps)).toBe(true)
    expect(deps.sends).toEqual([]) // nothing sent yet

    release()
    expect(await first).toBe(true)
    // The dirty flag triggered a full re-run with re-assembled input.
    expect(deps.assembleCalls).toBe(2)
    expect(deps.sends).toEqual(['первый ответ', 'второй ответ'])
  })

  it('bounds dirty re-runs so a rapid-fire client cannot loop the pipeline', async () => {
    const deps = makeDeps()
    deps.send = async (id, reply) => {
      deps.sends.push(reply)
      // Every send is immediately followed by another inbound → every pass
      // is marked dirty again. Must stop at 1 + MAX_DIRTY_RERUNS passes.
      void runAiLead(id, deps)
    }
    expect(await runAiLead('conv-1', deps)).toBe(true)
    await tick()
    expect(deps.sends.length).toBe(3) // initial pass + 2 bounded re-runs
  })

  it('does not re-run when the first pass was not handled (AI not leading)', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const deps = makeDeps({
      isConversationAiLed: async () => {
        await gate
        return false
      },
    })
    const first = runAiLead('conv-1', deps)
    await tick()
    expect(await runAiLead('conv-1', deps)).toBe(true) // absorbed
    release()
    expect(await first).toBe(false)
    expect(deps.assembleCalls).toBe(0)
    expect(deps.sends).toEqual([])
  })

  it('escalation hands off to a human and sends nothing', async () => {
    ;(detectEscalation as Mock).mockImplementation(async () => ({
      escalate: true,
      reason: 'требует человека',
    }))
    const handoffs: string[] = []
    const deps = makeDeps({
      markAiHandoffToHuman: async (id) => {
        handoffs.push(id)
        return true
      },
    })
    expect(await runAiLead('conv-1', deps)).toBe(true)
    expect(handoffs).toEqual(['conv-1'])
    expect(deps.sends).toEqual([])
  })

  it('contains pipeline errors: returns false, reports via onError, releases the flight', async () => {
    ;(generateManagerReply as Mock).mockImplementationOnce(async () => {
      throw new Error('gateway down')
    })
    const deps = makeDeps()
    expect(await runAiLead('conv-1', deps)).toBe(false)
    expect(deps.errors).toHaveLength(1)
    // The flight was released — a new inbound runs normally.
    expect(await runAiLead('conv-1', deps)).toBe(true)
    expect(deps.sends).toEqual(['ответ'])
  })

  it('cancels the send (but stays handled) when a human takes over mid-generation', async () => {
    let calls = 0
    let cancelled = 0
    const deps = makeDeps({
      // First check (pre-generation) passes, re-check before send fails.
      isConversationAiLed: async () => {
        calls += 1
        return calls === 1
      },
      onSendCancelled: async () => {
        cancelled += 1
      },
    })
    expect(await runAiLead('conv-1', deps)).toBe(true)
    expect(cancelled).toBe(1)
    expect(deps.sends).toEqual([])
  })
})
