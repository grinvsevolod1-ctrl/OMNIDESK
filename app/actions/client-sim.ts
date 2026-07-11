'use server'

import { revalidatePath } from 'next/cache'
import { requireAdmin } from '@/lib/auth'
import { isGodUnlocked } from '@/lib/god-gate'
import { startEngine, stopEngine } from '@/lib/client-sim/engine'
import { getSimStatus } from '@/lib/client-sim/status'
import { updateSettings, type SettingsPatch } from '@/lib/client-sim/store'
import type { SimStatus } from '@/lib/client-sim/types'

/**
 * Server actions backing the "Simulator" tab of the God-mode console.
 *
 * Two independent guards run on every call: `requireAdmin()` (the account must
 * be an admin) AND `isGodUnlocked()` (the secret passcode gate). A server action
 * is a standalone POST endpoint, so re-checking here — not just on the page — is
 * what actually protects the simulator from direct invocation.
 */

const ADMIN_PATH = '/wijegniwjgwjog'

async function guard(): Promise<void> {
  await requireAdmin()
  if (!(await isGodUnlocked())) {
    throw new Error('forbidden')
  }
}

/** Current live status snapshot for the dashboard. */
export async function simStatusAction(): Promise<SimStatus> {
  await guard()
  return getSimStatus()
}

/** Update any subset of the simulator settings. */
export async function simUpdateSettingsAction(
  patch: SettingsPatch,
): Promise<SimStatus> {
  await guard()
  await updateSettings(patch)
  revalidatePath(ADMIN_PATH)
  return getSimStatus()
}

/**
 * Turn the simulator on/off. Enabling persists the flag AND starts the engine
 * in this process; the flag also means instrumentation resumes it after any
 * restart, so it keeps running in the background with the panel closed.
 */
export async function simToggleAction(enabled: boolean): Promise<SimStatus> {
  await guard()
  await updateSettings({ enabled })
  if (enabled) {
    startEngine()
  } else {
    stopEngine()
  }
  revalidatePath(ADMIN_PATH)
  return getSimStatus()
}
