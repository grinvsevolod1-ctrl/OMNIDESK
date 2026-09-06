'use client'

/**
 * Segment-level error boundary for /buyer. Reuses the root error card, but
 * because it sits INSIDE the /buyer layout the navigation survives a crash —
 * an exception on one page no longer blanks the whole panel.
 */
export { default } from '../error'
