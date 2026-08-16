import type { MetadataRoute } from 'next'

/**
 * Web app manifest for the Omnidesk panel. Enables installability (PWA) and
 * provides the icons used by browsers and the OS app launcher. The icons live
 * in /public and are reused by the push service worker (public/sw.js).
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Omnidesk — единый центр входящих',
    short_name: 'Omnidesk',
    description:
      'Self-hosted панель для Telegram, WhatsApp и онлайн-чатов сайтов.',
    start_url: '/app/inbox',
    display: 'standalone',
    background_color: '#0a0a0a',
    theme_color: '#0a0a0a',
    icons: [
      {
        src: '/app-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/app-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
    ],
  }
}
