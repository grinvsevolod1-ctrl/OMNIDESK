/**
 * Proxies: CRUD, assignment, descriptors, availability and per-manager
 * proxy analytics.
 * Split out of the former monolithic lib/data.ts; re-exported via lib/data.ts.
 */
import { randomUUID } from 'crypto'
import { query } from '../db'
import { decrypt, encrypt } from '../crypto'
import type { ProxyDescriptor } from '../proxy-agent'
import type {
  ChannelType,
  Manager,
  ManagerProxySummary,
  Proxy,
  ProxyAnalytics,
  ProxyKind,
  ProxyStatus,
  Role,
} from '../types'

/* ------------------------------ Proxies ----------------------------- */

interface ProxyRow {
  id: string
  manager_id: string | null
  created_by_role: Role
  created_by_manager_id: string | null
  label: string
  kind: ProxyKind
  host: string
  port: number
  username_enc: string | null
  password_enc: string | null
  secret_enc: string | null
  status: ProxyStatus
  last_error: string | null
  created_at: string | Date
  assigned_manager_name?: string | null
  owner_manager_name?: string | null
}

function toProxy(r: ProxyRow): Proxy {
  return {
    id: r.id,
    managerId: r.manager_id ?? null,
    assignedManagerName: r.assigned_manager_name ?? null,
    createdByRole: (r.created_by_role ?? 'admin') as Role,
    createdByManagerId: r.created_by_manager_id ?? null,
    ownerManagerName: r.owner_manager_name ?? null,
    label: r.label,
    kind: r.kind,
    host: r.host,
    port: Number(r.port),
    hasAuth: Boolean(r.username_enc || r.secret_enc),
    status: r.status,
    lastError: r.last_error ?? null,
    createdAt: new Date(r.created_at).toISOString(),
  }
}

/**
 * Proxies a manager can use: every proxy ASSIGNED to them (admin pool hand-outs
 * + their own self-created proxies, which are auto-assigned to themselves). This
 * is what powers the connect-wizard picker.
 */
export async function listProxies(managerId: string): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT * FROM proxies
      WHERE manager_id = $1 OR created_by_manager_id = $1
      ORDER BY created_at DESC`,
    [managerId],
  )
  return rows.map(toProxy)
}

/**
 * Proxies a manager OWNS (self-created) — the ones they can edit/delete on their
 * own /app/proxies tab. Admin-assigned proxies are intentionally excluded here.
 */
export async function listManagerOwnedProxies(
  managerId: string,
): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT * FROM proxies
      WHERE created_by_role = 'manager' AND created_by_manager_id = $1
      ORDER BY created_at DESC`,
    [managerId],
  )
  return rows.map(toProxy)
}

/**
 * Proxies an admin has ASSIGNED to this manager but that the manager does NOT
 * own (read-only for the manager). Shown for transparency on their tab.
 */
export async function listManagerAssignedProxies(
  managerId: string,
): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT * FROM proxies
      WHERE manager_id = $1::uuid
        AND (created_by_role = 'admin' OR created_by_manager_id <> $1::uuid)
      ORDER BY created_at DESC`,
    [managerId],
  )
  return rows.map(toProxy)
}

/** Every proxy, with assigned-manager and owner-manager names joined in. */
export async function listAllProxies(): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT p.*, m.name AS assigned_manager_name, o.name AS owner_manager_name
       FROM proxies p
       LEFT JOIN managers m ON m.id = p.manager_id
       LEFT JOIN managers o ON o.id = p.created_by_manager_id
      ORDER BY p.created_at DESC`,
  )
  return rows.map(toProxy)
}

export async function getProxyById(id: string): Promise<Proxy | null> {
  const rows = await query<ProxyRow>(
    `SELECT p.*, m.name AS assigned_manager_name, o.name AS owner_manager_name
       FROM proxies p
       LEFT JOIN managers m ON m.id = p.manager_id
       LEFT JOIN managers o ON o.id = p.created_by_manager_id
      WHERE p.id = $1 LIMIT 1`,
    [id],
  )
  return rows[0] ? toProxy(rows[0]) : null
}

/**
 * Create a proxy. Ownership is explicit:
 *   - admin: lands in the pool, optionally pre-assigned to a manager.
 *   - manager: owned by + auto-assigned to that manager (managerId is forced to
 *     the owner so it shows up in their wizard immediately).
 */
export async function createProxy(input: {
  label: string
  kind: ProxyKind
  host: string
  port: number
  username?: string | null
  password?: string | null
  secret?: string | null
  createdByRole: Role
  createdByManagerId?: string | null
  managerId?: string | null
}): Promise<Proxy> {
  const id = randomUUID()
  const usernameEnc = input.username ? encrypt(input.username) : null
  const passwordEnc = input.password ? encrypt(input.password) : null
  const secretEnc = input.secret ? encrypt(input.secret) : null
  const isManager = input.createdByRole === 'manager'
  const ownerId = isManager ? (input.createdByManagerId ?? null) : null
  // Manager-created proxies are always assigned to their creator.
  const assignedTo = isManager ? ownerId : (input.managerId ?? null)
  const rows = await query<ProxyRow>(
    `INSERT INTO proxies
       (id, manager_id, created_by_role, created_by_manager_id, label, kind,
        host, port, username_enc, password_enc, secret_enc, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'unknown')
     RETURNING *`,
    [
      id,
      assignedTo,
      input.createdByRole,
      ownerId,
      input.label,
      input.kind,
      input.host,
      input.port,
      usernameEnc,
      passwordEnc,
      secretEnc,
    ],
  )
  return toProxy(rows[0])
}

/** Assign (or unassign with null) a proxy to a manager. Admin only. */
export async function assignProxy(
  id: string,
  managerId: string | null,
): Promise<void> {
  await query('UPDATE proxies SET manager_id = $2 WHERE id = $1', [
    id,
    managerId,
  ])
}

/**
 * Delete a proxy. When ownerManagerId is supplied the delete is SCOPED to a
 * manager's own proxies (a manager can never delete an admin proxy or another
 * manager's proxy). Admin calls omit it for full control. channels.proxy_id is
 * set NULL via the FK either way. Returns true when a row was removed.
 */
export async function deleteProxy(
  id: string,
  ownerManagerId?: string,
): Promise<boolean> {
  if (ownerManagerId) {
    const rows = await query<{ id: string }>(
      `DELETE FROM proxies
        WHERE id = $1 AND created_by_role = 'manager' AND created_by_manager_id = $2
        RETURNING id`,
      [id, ownerManagerId],
    )
    return rows.length > 0
  }
  const rows = await query<{ id: string }>(
    'DELETE FROM proxies WHERE id = $1 RETURNING id',
    [id],
  )
  return rows.length > 0
}

/**
 * Authorisation helper: can this manager run a connectivity check / manage this
 * proxy? True when they own it OR it's assigned to them.
 */
export async function managerCanUseProxy(
  proxyId: string,
  managerId: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM proxies
      WHERE id = $1 AND (manager_id = $2 OR created_by_manager_id = $2)
      LIMIT 1`,
    [proxyId, managerId],
  )
  return rows.length > 0
}

/**
 * Resolve a proxy's connection descriptor WITH decrypted credentials, for
 * server-side routing of provider HTTP traffic (see lib/proxy-agent.ts). This
 * returns plaintext proxy credentials — NEVER expose it to the client.
 */
export async function getProxyDescriptorById(
  id: string,
): Promise<ProxyDescriptor | null> {
  const rows = await query<ProxyRow>(
    'SELECT * FROM proxies WHERE id = $1 LIMIT 1',
    [id],
  )
  const r = rows[0]
  if (!r) return null
  let username: string | null = null
  let password: string | null = null
  try {
    if (r.username_enc) username = decrypt(r.username_enc)
    if (r.password_enc) password = decrypt(r.password_enc)
  } catch (err) {
    console.error(
      '[v0] getProxyDescriptorById: failed to decrypt credentials:',
      err,
    )
  }
  return {
    id: r.id,
    kind: r.kind,
    host: r.host,
    port: Number(r.port),
    username,
    password,
  }
}

/**
 * Resolve the proxy descriptor a channel routes through (null when it has none).
 * Used by the VK/MAX/WhatsApp dispatchers so every provider call exits via the
 * account's dedicated proxy IP.
 */
export async function getProxyForChannel(
  channelId: string,
): Promise<ProxyDescriptor | null> {
  const rows = await query<{ proxy_id: string | null }>(
    'SELECT proxy_id FROM channels WHERE id = $1 LIMIT 1',
    [channelId],
  )
  const pid = rows[0]?.proxy_id
  if (!pid) return null
  return getProxyDescriptorById(pid)
}

/**
 * Proxy allocation rule: a proxy serves AT MOST ONE account of each type. True
 * when another channel already uses this proxy for the same type (optionally
 * excluding a channel being edited).
 */
export async function proxyTypeInUse(
  proxyId: string,
  type: ChannelType,
  excludeChannelId?: string,
): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `SELECT id FROM channels
      WHERE proxy_id = $1 AND type = $2
        AND ($3::uuid IS NULL OR id <> $3::uuid)
      LIMIT 1`,
    [proxyId, type, excludeChannelId ?? null],
  )
  return rows.length > 0
}

/**
 * Proxies available to assign to a NEW account of `type`: every proxy NOT
 * already bound to another account of the same type (different types may share a
 * proxy). Optionally restricted to a manager's assigned/owned proxies.
 */
export async function listAvailableProxiesForType(
  type: ChannelType,
  managerId?: string,
): Promise<Proxy[]> {
  const rows = await query<ProxyRow>(
    `SELECT p.*, m.name AS assigned_manager_name, o.name AS owner_manager_name
       FROM proxies p
       LEFT JOIN managers m ON m.id = p.manager_id
       LEFT JOIN managers o ON o.id = p.created_by_manager_id
      WHERE NOT EXISTS (
              SELECT 1 FROM channels c
               WHERE c.proxy_id = p.id AND c.type = $1
            )
        AND ($2::uuid IS NULL
             OR p.manager_id = $2::uuid
             OR p.created_by_manager_id = $2::uuid)
      ORDER BY p.created_at DESC`,
    [type, managerId ?? null],
  )
  return rows.map(toProxy)
}


/* ------------------------- Proxy analytics ------------------------- */

/** System-wide proxy analytics for the admin proxies page. */
export async function getProxyAnalytics(): Promise<ProxyAnalytics> {
  const [agg, routed] = await Promise.all([
    query<{
      total: string
      ok: string
      error: string
      unknown: string
      assigned: string
      admin_owned: string
      manager_owned: string
    }>(
      `SELECT
         count(*)::int AS total,
         count(*) FILTER (WHERE status = 'ok')::int AS ok,
         count(*) FILTER (WHERE status = 'error')::int AS error,
         count(*) FILTER (WHERE status = 'unknown')::int AS unknown,
         count(*) FILTER (WHERE manager_id IS NOT NULL)::int AS assigned,
         count(*) FILTER (WHERE created_by_role = 'admin')::int AS admin_owned,
         count(*) FILTER (WHERE created_by_role = 'manager')::int AS manager_owned
       FROM proxies`,
    ),
    query<{ n: string }>(
      `SELECT count(*)::int AS n FROM channels WHERE proxy_id IS NOT NULL`,
    ),
  ])
  const a = agg[0]
  const total = Number(a?.total ?? 0)
  const assigned = Number(a?.assigned ?? 0)
  return {
    total,
    ok: Number(a?.ok ?? 0),
    error: Number(a?.error ?? 0),
    unknown: Number(a?.unknown ?? 0),
    assigned,
    unassigned: total - assigned,
    adminOwned: Number(a?.admin_owned ?? 0),
    managerOwned: Number(a?.manager_owned ?? 0),
    channelsRouted: Number(routed[0]?.n ?? 0),
  }
}

/**
 * Per-manager proxy rollup for the admin "by manager" view. Every manager is
 * included (even with zero proxies) so the admin sees full coverage. Uses
 * scalar sub-selects keyed by manager id — cheap at this app's scale and keeps
 * the proxy ↔ manager linkage explicit.
 */
export async function listManagersWithProxies(): Promise<ManagerProxySummary[]> {
  const managers = await listManagers()
  if (managers.length === 0) return []
  const rows = await query<{
    manager_id: string
    total: string
    ok: string
    error: string
    unknown: string
    self_owned: string
    admin_assigned: string
  }>(
    `SELECT
       p.manager_id,
       count(*)::int AS total,
       count(*) FILTER (WHERE p.status = 'ok')::int AS ok,
       count(*) FILTER (WHERE p.status = 'error')::int AS error,
       count(*) FILTER (WHERE p.status = 'unknown')::int AS unknown,
       count(*) FILTER (WHERE p.created_by_role = 'manager')::int AS self_owned,
       count(*) FILTER (WHERE p.created_by_role = 'admin')::int AS admin_assigned
     FROM proxies p
     WHERE p.manager_id IS NOT NULL
     GROUP BY p.manager_id`,
  )
  const channelRows = await query<{ manager_id: string; n: string }>(
    `SELECT manager_id, count(*)::int AS n
       FROM channels WHERE proxy_id IS NOT NULL
      GROUP BY manager_id`,
  )
  const byId = new Map(rows.map((r) => [r.manager_id, r]))
  const channelsById = new Map(
    channelRows.map((r) => [r.manager_id, Number(r.n)]),
  )
  return managers.map((manager) => {
    const r = byId.get(manager.id)
    return {
      manager,
      total: Number(r?.total ?? 0),
      ok: Number(r?.ok ?? 0),
      error: Number(r?.error ?? 0),
      unknown: Number(r?.unknown ?? 0),
      selfOwned: Number(r?.self_owned ?? 0),
      adminAssigned: Number(r?.admin_assigned ?? 0),
      channelsRouted: channelsById.get(manager.id) ?? 0,
    }
  })
}

