'use client'

/**
 * Segment-level error boundary for /admin. Reuses the root error card, but
 * because it sits INSIDE the /admin layout the sidebar and navigation survive
 * a crash — an exception on one admin page no longer blanks the whole panel,
 * the admin can simply switch to another section.
 */
export { default } from '../error'
