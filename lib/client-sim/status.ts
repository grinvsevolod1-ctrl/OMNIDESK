import type { SimStatus } from './types'
import { aiConfigured } from './generate'
import { engineRunning } from './engine'
import { countActiveThreads, getSettings, threadsByState } from './store'

/** Full snapshot for the god-panel dashboard. */
export async function getSimStatus(): Promise<SimStatus> {
  const [settings, activeThreads, byState] = await Promise.all([
    getSettings(),
    countActiveThreads(),
    threadsByState(),
  ])
  return {
    ...settings,
    running: engineRunning(),
    activeThreads,
    byState,
    aiConfigured: aiConfigured(),
  }
}
