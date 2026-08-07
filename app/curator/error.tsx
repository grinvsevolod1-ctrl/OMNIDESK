'use client'

/**
 * Segment-level error boundary for /curator. Reuses the root error card, but
 * because it sits INSIDE the /curator layout the navigation survives a crash —
 * an exception on one curator page no longer blanks the whole panel.
 */
export { default } from '../error'
