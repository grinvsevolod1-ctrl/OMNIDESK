import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Three lists describe the same thing — which channel_jobs.action values
 * exist — and they live in three places that nothing ties together:
 *
 *   1. the JobAction union (lib/types/jobs.ts) — what the panel may enqueue;
 *   2. the worker's `switch (job.action)` (worker/src/registry.ts) — what
 *      gets executed;
 *   3. the CHECK constraint channel_jobs_action_check — what Postgres lets
 *      INSERT at all.
 *
 * 'send_file' was added to (1) and (2) but the constraint stayed at migration
 * 103, so every photo/file send from the composer failed on INSERT for months
 * and surfaced only as «Медиа недоступно» (migration 160 fixed the data).
 * This guard parses all three sources and fails CI on the next divergence.
 */

const ROOT = join(__dirname, '..', '..')

function readSource(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8')
}

/** Latest migration that (re)asserts the constraint, with its action list. */
function latestActionCheck(): { file: string; actions: string[] } {
  const dir = join(ROOT, 'scripts')
  const files = readdirSync(dir)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .sort()
  let found: { file: string; actions: string[] } | null = null
  for (const file of files) {
    const src = readFileSync(join(dir, file), 'utf8')
    const match = src.match(
      /ADD CONSTRAINT channel_jobs_action_check CHECK \(\s*action IN \(([\s\S]*?)\)\s*\)/,
    )
    if (!match) continue
    found = {
      file,
      actions: [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]),
    }
  }
  if (!found) throw new Error('no migration defines channel_jobs_action_check')
  return found
}

function jobActionUnion(): string[] {
  const src = readSource('lib/types/jobs.ts')
  const start = src.indexOf('export type JobAction =')
  const end = src.indexOf('export type JobStatus')
  const body = src.slice(start, end).replace(/\/\/.*$/gm, '')
  return [...body.matchAll(/\|\s*'([a-z_]+)'/g)].map((m) => m[1])
}

function workerHandledActions(): string[] {
  const src = readSource('worker/src/registry.ts')
  const start = src.indexOf('switch (job.action)')
  expect(start, 'registry.ts must dispatch on job.action').toBeGreaterThan(-1)
  return [...src.slice(start).matchAll(/^\s+case '([a-z_]+)':/gm)].map(
    (m) => m[1],
  )
}

describe('channel_jobs.action stays consistent across type, worker and DB', () => {
  const union = jobActionUnion()
  const constraint = latestActionCheck()
  const handled = workerHandledActions()

  it('parses all three sources', () => {
    expect(union.length).toBeGreaterThan(10)
    expect(constraint.actions.length).toBeGreaterThan(10)
    expect(handled.length).toBeGreaterThan(10)
  })

  it(`every JobAction is allowed by ${constraint.file}`, () => {
    const missing = union.filter((a) => !constraint.actions.includes(a))
    expect(
      missing,
      `add a migration re-asserting channel_jobs_action_check with: ${missing.join(', ')}`,
    ).toEqual([])
  })

  it('every JobAction has a case in the worker switch', () => {
    const missing = union.filter((a) => !handled.includes(a))
    expect(missing, `worker/src/registry.ts lacks: ${missing.join(', ')}`).toEqual(
      [],
    )
  })

  it('send_file specifically is enqueue-able (the regression that shipped)', () => {
    expect(constraint.actions).toContain('send_file')
  })
})
