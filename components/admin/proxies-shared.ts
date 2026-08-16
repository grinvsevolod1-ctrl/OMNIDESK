/**
 * Filter/sort types and the sentinel value shared between proxies-admin.tsx
 * (the container) and proxies-views.tsx (the presentational tables). Kept in a
 * types-only module so the two component files don't import each other.
 */

import type { Proxy } from '@/lib/types'

/** Select value standing in for "no manager assigned" (empty string is unusable in a Select). */
export const UNASSIGNED = 'unassigned'

export type StatusFilter = 'all' | Proxy['status']
export type OwnerFilter = 'all' | 'admin' | 'manager'
export type AssignFilter = 'all' | 'assigned' | 'unassigned'
export type SortMode = 'recent' | 'label' | 'status' | 'manager'
