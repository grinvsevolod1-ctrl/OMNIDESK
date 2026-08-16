import type { Role } from './accounts'
import type { Manager } from './accounts'

export type ProxyKind = 'socks5' | 'http' | 'mtproto'
export type ProxyStatus = 'unknown' | 'ok' | 'error'

export interface Proxy {
  id: string
  /**
   * The manager this proxy is ASSIGNED to (the account that routes connections
   * through it), or null when it sits unassigned in the admin pool. Assignment
   * is independent of ownership: an admin can assign a pool proxy to a manager,
   * and a manager-owned proxy is auto-assigned to its creator.
   */
  managerId: string | null
  /** Display name of the assigned manager (admin views only). */
  assignedManagerName?: string | null
  /** Who created/owns the proxy. Admin-owned proxies are read-only for managers. */
  createdByRole: Role
  /** The manager who created it (null for admin-created proxies). */
  createdByManagerId: string | null
  /** Display name of the owner manager, when created by a manager (admin views). */
  ownerManagerName?: string | null
  label: string
  kind: ProxyKind
  host: string
  port: number
  /** True when credentials are stored (values themselves stay encrypted). */
  hasAuth: boolean
  status: ProxyStatus
  lastError: string | null
  createdAt: string
}

export interface ProxyAnalytics {
  total: number
  /** Health rollup across every proxy. */
  ok: number
  error: number
  unknown: number
  /** Assigned to a manager vs. sitting unused in the pool. */
  assigned: number
  unassigned: number
  /** Ownership split. */
  adminOwned: number
  managerOwned: number
  /** Number of channels currently routed through a proxy. */
  channelsRouted: number
}

export interface ManagerProxySummary {
  manager: Manager
  /** Proxies assigned to this manager. */
  total: number
  ok: number
  error: number
  unknown: number
  /** How many of the assigned proxies the manager created themselves. */
  selfOwned: number
  /** How many were handed down by the admin. */
  adminAssigned: number
  /** Channels this manager routes through a proxy. */
  channelsRouted: number
}
