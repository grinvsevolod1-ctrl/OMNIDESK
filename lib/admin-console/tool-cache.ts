import 'server-only'

/**
 * The TTL cache moved to the shared console core (lib/console-core) so both
 * conversational consoles use one implementation. This module remains as a
 * thin re-export to keep existing import paths stable.
 */
export { cached } from '@/lib/console-core'
