import { createHash, timingSafeEqual } from 'crypto'

/**
 * Constant-time string comparison that does not leak length via early return.
 * Both sides are SHA-256 hashed first so `timingSafeEqual` always receives
 * equal-length buffers regardless of input length.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}
