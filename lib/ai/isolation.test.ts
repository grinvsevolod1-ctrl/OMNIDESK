import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Isolation guard: the AI-manager co-pilot features (analytics, follow-up,
 * auto-lessons, deal-heat) must NEVER be coupled to the client simulator or the
 * god panel. This test statically scans each new module's source for forbidden
 * imports/references, so a future edit that reaches into `client-sim`,
 * `god-gate` or the secret panel fails CI instead of silently leaking.
 *
 * Note: this is about CODE coupling, not data. Simulated dialogs are ordinary
 * conversations for the AI; nothing here filters `is_simulated`.
 */

const ROOT = join(__dirname, '..', '..')

// Files that make up the co-pilot / AI-manager feature surface added or touched
// for the "everything via chat" work.
const GUARDED_FILES = [
  'lib/ai/deal-heat.ts',
  'lib/data/ai-analytics.ts',
  'lib/data/ai-followup.ts',
  'lib/followup/runtime.ts',
  'app/api/cron/followup/route.ts',
  'lib/ai-console/run-assistant.ts',
]

// Any of these appearing in an import/require or path string means the module
// has been coupled to the simulator or god panel.
const FORBIDDEN = [
  'client-sim',
  'god-gate',
  'god-panel',
  'secret-panel',
  'wijegniwjgwjog',
  'sim_threads',
  'sim-threads',
]

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('AI co-pilot isolation from simulator / god panel', () => {
  for (const rel of GUARDED_FILES) {
    it(`${rel} does not import or reference sim/god internals`, () => {
      const src = readSource(rel)
      for (const needle of FORBIDDEN) {
        expect(
          src.includes(needle),
          `${rel} must not reference "${needle}"`,
        ).toBe(false)
      }
    })
  }

  it('deal-heat and followup never import from the simulator engine', () => {
    for (const rel of ['lib/ai/deal-heat.ts', 'lib/followup/runtime.ts']) {
      const src = readSource(rel)
      // No import lines pulling anything under lib/client-sim/*.
      expect(/from\s+['"][^'"]*client-sim/.test(src)).toBe(false)
      expect(/import\s*\(\s*['"][^'"]*client-sim/.test(src)).toBe(false)
    }
  })
})
