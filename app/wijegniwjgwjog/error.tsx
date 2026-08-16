'use client'

/**
 * Segment-level error boundary for the god panel. Reuses the root error card;
 * scoping it to this segment keeps the god layout alive when a single page
 * (messenger, dashboard tab) throws, instead of unmounting everything.
 */
export { default } from '../error'
