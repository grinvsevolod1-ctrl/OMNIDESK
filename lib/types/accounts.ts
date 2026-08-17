export type Role = 'admin' | 'manager' | 'curator' | 'head'

/** DB-backed account role stored on the managers table (admin is env-only). */
export type AccountRole = 'manager' | 'curator' | 'head'

export type ManagerStatus = 'active' | 'blocked'

export interface Manager {
  id: string
  name: string
  email: string
  /** Short login derived from the email local-part; usable to sign in. */
  username: string | null
  status: ManagerStatus
  /** True while the manager is on lunch — new conversations route elsewhere. */
  onLunch: boolean
  /**
   * Account role on the managers table. Defaults to 'manager' for every row
   * that predates migration 111. Curators are created by the admin and carry
   * a required `city`.
   */
  role: AccountRole
  /**
   * City the curator is responsible for. Always set for role = 'curator',
   * always null for role = 'manager'.
   */
  city: string | null
  /**
   * Edit permission for role = 'head': false = «только просмотр»,
   * true = «просмотр и редактирование». Always false for other roles.
   */
  headCanEdit: boolean
  createdAt: string
}

export interface SessionUser {
  sub: string
  role: Role
  email: string
  name: string
  /**
   * Session version stamped into the JWT at login. Re-checked against the
   * manager's current `session_version` on every request so password changes
   * or blocks revoke outstanding sessions immediately. Admin sessions are 0.
   * Curators share the same session_version machinery as managers.
   */
  sv?: number
}
