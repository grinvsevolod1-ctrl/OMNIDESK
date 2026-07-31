/**
 * Cross-thread anti-repetition memory for the client simulator. A process-wide
 * ring buffer of the lines and opening words the bot swarm recently sent across
 * ALL conversations, so different 'clients' never echo each other. Pure
 * in-process state (no DB); extracted from the client-sim store monolith and
 * re-exported from it for backward compatibility.
 */

/**
 * A process-wide ring buffer of the most recent lines the bots actually sent
 * across ALL conversations. Per-thread history already stops a single persona
 * repeating itself; this catches the population-level tell where many "clients"
 * independently send the same phrase. The generator consults it to avoid
 * reusing anything the swarm just said, so bots never get caught echoing each
 * other or firing identical replies at the same time.
 */
const GLOBAL_LINE_MEMORY_SIZE = 160
const GLOBAL_OPENER_MEMORY_SIZE = 60
const g = globalThis as unknown as {
  __simGlobalLines?: string[]
  __simGlobalOpeners?: string[]
}

function globalLines(): string[] {
  if (!g.__simGlobalLines) g.__simGlobalLines = []
  return g.__simGlobalLines
}

function globalOpeners(): string[] {
  if (!g.__simGlobalOpeners) g.__simGlobalOpeners = []
  return g.__simGlobalOpeners
}

/** First meaningful word of a line, lowercased and stripped of punctuation. */
function openerOf(line: string): string {
  const first = line
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)[0]
  return first ?? ''
}

/** Record a line the swarm just sent (deduped, capped) + its opening word. */
export function rememberGlobalLine(line: string): void {
  const trimmed = line.trim()
  if (!trimmed) return
  const buf = globalLines()
  buf.push(trimmed)
  if (buf.length > GLOBAL_LINE_MEMORY_SIZE) {
    buf.splice(0, buf.length - GLOBAL_LINE_MEMORY_SIZE)
  }
  const opener = openerOf(trimmed)
  if (opener) {
    const ob = globalOpeners()
    ob.push(opener)
    if (ob.length > GLOBAL_OPENER_MEMORY_SIZE) {
      ob.splice(0, ob.length - GLOBAL_OPENER_MEMORY_SIZE)
    }
  }
}

/** The most recent `n` lines sent anywhere, newest last. */
export function getGlobalRecentLines(n = 40): string[] {
  const buf = globalLines()
  return buf.slice(-Math.max(0, n))
}

/** Wipe the swarm's in-process line/opener memory (used by a full reset so a
 *  fresh population doesn't inherit phrases from the wiped one). */
export function clearGlobalLineMemory(): void {
  g.__simGlobalLines = []
  g.__simGlobalOpeners = []
}

/**
 * The distinct opening words the swarm used recently. Injected into the prompt
 * so a fresh message never starts with a word the crowd just used — different
 * "people" opening identically is one of the loudest bot-farm tells.
 */
export function getGlobalRecentOpeners(n = 30): string[] {
  const buf = globalOpeners().slice(-Math.max(0, n))
  return Array.from(new Set(buf))
}
