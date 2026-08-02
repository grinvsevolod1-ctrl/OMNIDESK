'use client'

/**
 * Segment-level error boundary for /app (the manager panel). Reuses the root
 * error card, but because it sits INSIDE the /app layout the sidebar and
 * navigation survive a crash — an exception in the inbox no longer blanks the
 * whole panel, the manager can simply switch to another section.
 */
export { default } from '../error'
