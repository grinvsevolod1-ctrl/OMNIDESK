/**
 * Data-access layer for the client-simulator ("god-mode" synthetic dialogues).
 *
 * This file is a thin barrel. The SQL lives in focused per-domain modules under
 * ./store/ (settings / campaign / threads / conversations / transcript), with
 * the shared row shapes, runtime column probes and row→domain mappers in
 * ./store/internal. Everything is re-exported so existing imports from
 * '@/lib/client-sim/store' keep working unchanged.
 */

export * from './store/settings'
export * from './store/campaign'
export * from './store/threads'
export * from './store/conversations'
export * from './store/transcript'
