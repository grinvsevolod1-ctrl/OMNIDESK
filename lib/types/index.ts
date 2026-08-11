/**
 * Domain types barrel. Previously a single `lib/types.ts`; split by domain for
 * readability. Re-exported here so every existing `@/lib/types` import keeps
 * working unchanged.
 */
export * from './accounts'
export * from './channels'
export * from './proxies'
export * from './jobs'
export * from './leads'
export * from './messages'
export * from './conversations'
export * from './hosting'
