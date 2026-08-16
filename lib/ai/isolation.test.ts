import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Isolation guard: the AI-manager co-pilot features (analytics, follow-up,
 * auto-lessons, deal-heat) must NEVER be coupled to the god panel — and must
 * never re-introduce the removed client simulator. This test statically scans
 * each module's source for forbidden imports/references, so a future edit that
 * reaches into `client-sim`, `god-gate` or the secret panel fails CI instead of
 * silently leaking.
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
  // ИИ-строка Обзора (каскад уровней 1→3) и её слой данных: admin-видимая
  // поверхность, обязана оставаться слепой к god-панели и personal-аккаунтам.
  'lib/ai-overview/types.ts',
  'lib/ai-overview/intents.ts',
  'lib/ai-overview/handlers.ts',
  'lib/ai-overview/run-overview-ai.ts',
  'lib/data/sources.ts',
  'app/actions/overview-ai.ts',
  'app/actions/sources.ts',
]

// Any of these appearing in an import/require or path string means the module
// has been coupled to the simulator or god panel.
const FORBIDDEN = [
  'client-sim',
  'god-gate',
  'god-panel',
  'god-sites',
  'god_sites',
  'secret-panel',
  'wijegniwjgwjog',
  'sim_threads',
  'sim-threads',
  // Личные Telegram-аккаунты владельца (миграция 135) — тоже god-структура:
  // co-pilot и мозг продавца не должны знать об их существовании.
  'telegram_personal',
  'telegram-personal',
]

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

describe('AI co-pilot isolation from simulator / god panel', () => {
  for (const rel of GUARDED_FILES) {
    it(`${rel} does not import or reference sim/god internals`, () => {
      // Единственная легальная форма упоминания personal-аккаунтов в
      // admin-видимом коде — SQL-фильтр, который их ИСКЛЮЧАЕТ из выборки.
      const src = readSource(rel).replaceAll(
        "type <> 'telegram_personal'",
        '',
      )
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
 * Personal Telegram isolation (миграция 135): личные аккаунты владельца
 * живут в channels под type='telegram_personal', и обычные admin-видимые
 * выборки обязаны их исключать. Эти проверки статически убеждаются, что
 * фильтр не потеряли при правке запросов.
 */
describe('personal Telegram accounts stay invisible to the regular panel', () => {
  it('listAllChannels excludes telegram_personal', () => {
    const src = readSource('lib/data/channels.ts')
    const fn = src.slice(src.indexOf('export async function listAllChannels'))
    const body = fn.slice(0, fn.indexOf('export async function', 10))
    expect(
      body.includes("type <> 'telegram_personal'"),
      'listAllChannels must filter out personal accounts',
    ).toBe(true)
  })

  it('getSystemHealth channel scan excludes telegram_personal', () => {
    const src = readSource('lib/data/ai-health.ts')
    expect(
      src.includes("type <> 'telegram_personal'"),
      'ai-health channel query must filter out personal accounts',
    ).toBe(true)
  })

  it('manager inbox and seller pipeline never reference personal accounts', () => {
    for (const rel of [
      'lib/data/conversations.ts',
      'lib/data/conversation-messages.ts',
      'lib/ai/manager-brain.ts',
    ]) {
      const src = readSource(rel)
      expect(
        src.includes('telegram_personal'),
        `${rel} must not reference telegram_personal`,
      ).toBe(false)
    }
  })
})

/**
 * Encoding guard: the Russian-language prompt strings that steer the customer
 * reply live inside these modules. A botched save that mangles a multi-byte
 * character (the U+FFFD replacement char) silently corrupts an instruction the
 * model reads verbatim — e.g. a word with a swallowed letter in the middle —
 * which is exactly the kind of bug that slips past a type-check. Fail CI if
 * any of them carry U+FFFD.
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
    // The servers co-pilot: its system prompt and tool descriptions are also
    // Russian text the model reads verbatim (a mangled char shipped here once).
    'lib/servers-console/assistant.ts',
    'lib/servers-console/tools.ts',
    'lib/servers-console/prompt.ts',
    'lib/servers-console/intents.ts',
    // ИИ-строка Обзора: system-промпты роутера и агента — русский текст,
    // который модель читает дословно.
    'lib/ai-overview/run-overview-ai.ts',
    'lib/ai-overview/intents.ts',
    'lib/ai-overview/handlers.ts',
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

/**
 * Repo-wide encoding guard. The prompt-file list above proved insufficient:
 * U+FFFD corruption shipped in UI strings (user-visible toasts, labels) and —
 * worst of all — inside a currency-class REGEX in the extension template,
 * silently breaking a feature for non-$ currencies. Cyrillic source is
 * especially vulnerable to bad-encoding saves, so scan EVERY tracked source
 * file. Costs a few hundred ms; catches a whole class of bug type-checks
 * can't see.
 */
describe('no tracked source file contains U+FFFD (repo-wide)', () => {
  it('scans every tracked ts/tsx/js/mjs/json/sql/md file', () => {
    const files = execSync(
      "git ls-files '*.ts' '*.tsx' '*.js' '*.mjs' '*.json' '*.sql' '*.md'",
      { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 },
    )
      .toString()
      .trim()
      .split('\n')
      // This test file spells the char via an escape sequence only, but skip
      // it anyway so a future literal in an assertion can't self-trip.
      .filter((f) => f && !f.endsWith('lib/ai/isolation.test.ts'))
    const corrupted: string[] = []
    for (const f of files) {
      if (readSource(f).includes('\uFFFD')) corrupted.push(f)
    }
    expect(
      corrupted,
      `files with corrupted characters: ${corrupted.join(', ')}`,
    ).toEqual([])
  })
})
