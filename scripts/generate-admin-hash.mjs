#!/usr/bin/env node
/**
 * Generate a bcrypt hash for ADMIN_PASSWORD_HASH.
 *
 * Usage (from the project root on the VPS):
 *   pnpm generate-admin-hash 'your-strong-password'
 *
 * Uses bcryptjs — a pure-JS implementation that is ALREADY a project
 * dependency (lib/auth.ts verifies with the same library), so no native
 * compilation and no extra install is needed. Do NOT install the native
 * `bcrypt` package; it is a different module and unnecessary here.
 *
 * The password is read from argv, hashed with cost 12 (matching what
 * lib/auth.ts expects), and the resulting hash is printed to stdout.
 * Nothing is written to disk or logged anywhere else.
 */
import bcrypt from 'bcryptjs'

const password = process.argv[2]

if (!password) {
  console.error("Usage: pnpm generate-admin-hash 'your-strong-password'")
  console.error('Tip: single-quote the password so the shell keeps special characters intact.')
  process.exit(1)
}

if (password.length < 8) {
  console.error('Refusing: admin password must be at least 8 characters.')
  process.exit(1)
}

const hash = bcrypt.hashSync(password, 12)
console.log('')
console.log('Add this line to your .env on the VPS:')
console.log('')
console.log(`ADMIN_PASSWORD_HASH=${hash}`)
console.log('')
console.log('Then remove ADMIN_PASSWORD and restart the panel (pm2 restart).')
