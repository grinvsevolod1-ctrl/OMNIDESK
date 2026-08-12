import { createHash } from 'crypto'

/**
 * Admin session versioning.
 *
 * Managers/curators carry a DB-backed `session_version` that revokes their JWTs
 * the moment it is bumped. The admin has no DB row (env-configured account), so
 * historically an admin JWT stayed valid for its full 7-day lifetime even after
 * the admin password was rotated — rotating a leaked password did NOT evict the
 * attacker.
 *
 * Fix: derive a deterministic session version from the admin credentials
 * themselves. It is embedded as `sv` in admin JWTs at login and re-checked on
 * every request (getSession + proxy). Changing ADMIN_PASSWORD /
 * ADMIN_PASSWORD_HASH / ADMIN_EMAIL — or setting ADMIN_SESSION_NONCE — changes
 * the derived version and instantly invalidates every outstanding admin token
 * after the process restarts with the new env.
 *
 * The version is a 31-bit integer folded from a SHA-256 of the credential
 * material. It reveals nothing about the password (preimage-resistant, and the
 * value never leaves the signed JWT payload).
 */

let cached: number | null = null

export function adminSessionVersion(): number {
  if (cached !== null) return cached
  const material = [
    process.env.ADMIN_EMAIL || '',
    process.env.ADMIN_PASSWORD_HASH || '',
    process.env.ADMIN_PASSWORD || '',
    // Optional manual kill-switch: bump to force re-login of every admin
    // session without touching the password.
    process.env.ADMIN_SESSION_NONCE || '',
  ].join('\u0000')
  const digest = createHash('sha256').update(material).digest()
  // Fold the first 4 bytes into a positive 31-bit int (JWT-friendly number).
  cached = digest.readUInt32BE(0) & 0x7fffffff
  return cached
}

/** True when an admin JWT's `sv` matches the current credential material. */
export function isAdminSessionCurrent(sv: number | undefined): boolean {
  return (sv ?? 0) === adminSessionVersion()
}
