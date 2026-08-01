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
  // The co-pilot core plus the domain modules the former monolith was split
  // into — each contains tool code that must stay blind to sim/god internals.
  'lib/ai-console/run-assistant.ts',
  'lib/ai-console/run-state.ts',
  'lib/ai-console/prompt.ts',
  'lib/ai-console/tools-settings.ts',
  'lib/ai-console/tools-knowledge.ts',
  'lib/ai-console/tools-directives.ts',
  'lib/ai-console/tools-dialogs.ts',
  'lib/ai-console/tools-analytics.ts',
  'lib/ai-console/tools-quality.ts',
  // "Bigger brains" surfaces: system health, business memory + check cases.
  // getSystemHealth in particular reads channels/queue/balance — admin-visible
  // surfaces only — and must stay blind to the guarded subsystems forever.
  'lib/data/ai-health.ts',
  'lib/data/ai-copilot.ts',
  // A/B experiments overlay persona/tone/aggressiveness per conversation branch.
  // It sits on the customer-reply hot path and must never reach into the
  // simulator or god panel either.
  'lib/data/ai-experiments.ts',
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

/**
 * Encoding guard: the Russian-language prompt strings that steer the customer
 * reply live inside these modules. A botched save that mangles a multi-byte
 * character (the U+FFFD replacement char) silently corrupts an instruction the
 * model reads verbatim — e.g. «сохра�ит правила» — which is exactly the kind of
 * bug that slips past a type-check. Fail CI if any of them carry U+FFFD.
 */
/**
 * Purity guard: lib/ai/brain/* is shared with the standalone worker, which
 * imports it via a relative path under tsx and does NOT install the panel's
 * dependencies. Every brain module must therefore stay dependency-free: no
 * `@/` aliases, no `server-only`, no `ai` SDK, no DB — and it may only import
 * sibling modules from the same directory using a BARE relative path ('./core',
 * no `.js` suffix). The suffix matters: the worker's tsx resolves both forms,
 * but Next.js's bundler resolver does NOT map a './core.js' specifier onto the
 * real core.ts, so a `.js` suffix builds under the worker yet breaks the panel
 * with "Module not found". This used to be a comment-only rule; now it fails CI.
 */
describe('lib/ai/brain modules stay dependency-free (worker-safe)', () => {
  const BRAIN_FILES = [
    'lib/ai/brain/core.ts',
    'lib/ai/brain/prompt.ts',
    'lib/ai/brain/reply.ts',
    'lib/ai/brain/assess.ts',
    'lib/ai/brain/media.ts',
    'lib/ai/brain/embeddings.ts',
    'lib/ai/brain/training.ts',
  ]
  for (const rel of BRAIN_FILES) {
    it(`${rel} only imports sibling brain modules`, () => {
      const src = readSource(rel)
      const specifiers = [
        ...src.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g),
      ].map((m) => m[1])
      for (const spec of specifiers) {
        expect(
          /^\.\/[a-z-]+$/.test(spec),
          `${rel} imports "${spec}" — brain modules may only import a bare './sibling' (no .js suffix, which breaks the Next.js build)`,
        ).toBe(true)
      }
      // Match an actual import statement, not the doc comment that states the
      // rule ("no `server-only`") — a substring check would trip on itself.
      expect(
        /import\s+['"]server-only['"]/.test(src),
        `${rel} pulls in server-only`,
      ).toBe(false)
    })
  }

  // The public barrel re-exports the submodules; it must use the same bare
  // './brain/x' form so the panel build resolves it (the bug that shipped).
  it('manager-brain.ts barrel re-exports with bare paths (no .js)', () => {
    const src = readSource('lib/ai/manager-brain.ts')
    const specifiers = [
      ...src.matchAll(/from\s*['"](\.\/brain\/[^'"]+)['"]/g),
    ].map((m) => m[1])
    expect(specifiers.length).toBeGreaterThan(0)
    for (const spec of specifiers) {
      expect(
        /^\.\/brain\/[a-z-]+$/.test(spec),
        `manager-brain.ts re-exports "${spec}" — must be bare './brain/x' (a .js suffix breaks the Next.js build)`,
      ).toBe(true)
    }
  })
})

describe('AI prompt modules stay valid UTF-8 (no U+FFFD)', () => {
  const PROMPT_FILES = [
    'lib/ai/manager-brain.ts',
    // The brain implementation modules the former monolith was split into —
    // prompt.ts in particular IS the seller's personality, read verbatim.
    'lib/ai/brain/core.ts',
    'lib/ai/brain/prompt.ts',
    'lib/ai/brain/reply.ts',
    'lib/ai/brain/assess.ts',
    'lib/ai/brain/media.ts',
    'lib/ai/brain/embeddings.ts',
    'lib/ai/brain/training.ts',
    'lib/ai-console/run-assistant.ts',
    // The split-out co-pilot modules: the system prompt and every tool
    // description are Russian text the model reads verbatim.
    'lib/ai-console/prompt.ts',
    'lib/ai-console/tools-settings.ts',
    'lib/ai-console/tools-knowledge.ts',
    'lib/ai-console/tools-directives.ts',
    'lib/ai-console/tools-dialogs.ts',
    'lib/ai-console/tools-analytics.ts',
    'lib/ai-console/tools-quality.ts',
    'lib/autopilot/runtime.ts',
    'lib/data/ai-experiments.ts',
    // Simulator prompt/message text (Russian, read verbatim by the model and
    // posted into dialogs) — the same corruption class was found here too.
    'lib/client-sim/engine.ts',
    'lib/client-sim/generate.ts',
  ]
  for (const rel of PROMPT_FILES) {
    it(`${rel} contains no replacement characters`, () => {
      const src = readSource(rel)
      expect(src.includes('\uFFFD'), `${rel} has a corrupted character`).toBe(
        false,
      )
    })
  }
})
