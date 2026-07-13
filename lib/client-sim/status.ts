import type { SimStatus } from './types'
import { aiConfigured } from './generate'
import { engineRunning } from './engine'
import {
  countActiveThreads,
  getSettings,
  threadsByOutcome,
  threadsByState,
} from './store'
import { getAiAssistSettings } from '@/lib/data/ai-assist'

/** Full snapshot for the god-panel dashboard. */
export async function getSimStatus(): Promise<SimStatus> {
  const [settings, activeThreads, byState, byOutcome, aiManager] =
    await Promise.all([
      getSettings(),
      countActiveThreads(),
      threadsByState(),
      threadsByOutcome(),
      getAiAssistSettings().catch(() => null),
    ])
  return {
    ...settings,
    running: engineRunning(),
    activeThreads,
    byState,
    byOutcome,
    aiConfigured: aiConfigured(),
    aiManagerEnabled: Boolean(aiManager?.enabled),
  }
}
