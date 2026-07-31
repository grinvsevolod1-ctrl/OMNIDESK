import type { SimStatus } from './types'
import { aiConfigured } from './generate'
import { engineRunning } from './engine'
import {
  countActiveThreads,
  getSettings,
  threadsByOutcome,
  threadsByState,
} from './store'

/** Full snapshot for the god-panel dashboard. */
export async function getSimStatus(): Promise<SimStatus> {
  const [settings, activeThreads, byState, byOutcome] = await Promise.all([
    getSettings(),
    countActiveThreads(),
    threadsByState(),
    threadsByOutcome(),
  ])
  return {
    ...settings,
    running: engineRunning(),
    activeThreads,
    byState,
    byOutcome,
    aiConfigured: aiConfigured(),
  }
}
