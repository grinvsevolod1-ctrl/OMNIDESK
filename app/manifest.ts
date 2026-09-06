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
    // UI language + text direction. Play Store / PWABuilder read these to label
    // the generated store listing correctly.
    lang: 'ru',
    dir: 'ltr',
    categories: ['business', 'productivity'],
    // Stable identity so the OS treats every launch as the same installed app.
    id: '/app/inbox',
    start_url: '/app/inbox',
    // Scope '/' (not the start_url's '/app/' directory) keeps navigation to
    // /curator, /head, /login, the god routes, etc. INSIDE the standalone
    // window. Without it, iOS/Android would treat an out-of-scope link as an
    // external navigation and bounce the user out into a Safari/Chrome tab.
    scope: '/',
    display: 'standalone',
    // If a browser ever rejects 'standalone' it should still try before falling
    // back to a plain browser tab.
    display_override: ['standalone'],
    orientation: 'portrait',
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
      // Maskable variant: the mark sits in the central safe zone with full-bleed
      // background, so Android's adaptive-icon mask (circle/squircle/rounded)
      // never clips it. Without a maskable icon Android draws our square icon
      // inside a white plate — the #1 reason installed PWAs look broken.
      {
        src: '/app-icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
    // Screenshots power the richer install UI (Chrome/Edge desktop dialog) and
    // are REQUIRED by Google Play when wrapping the PWA via PWABuilder/Bubblewrap.
    // `wide` -> desktop listing, narrow (no form_factor) -> phone listing.
    screenshots: [
      {
        src: '/screenshots/desktop-login.png',
        sizes: '1920x1280',
        type: 'image/png',
        form_factor: 'wide',
        label: 'Omnidesk на компьютере',
      },
      {
        src: '/screenshots/mobile-login.png',
        sizes: '1080x1920',
        type: 'image/png',
        form_factor: 'narrow',
        label: 'Omnidesk на телефоне',
      },
    ],
  }
}
