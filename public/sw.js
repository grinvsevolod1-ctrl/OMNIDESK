/* Omnidesk push service worker.
 *
 * Receives Web Push messages and shows a notification, and focuses/opens the
 * inbox when the manager clicks it. Kept dependency-free and tiny so it loads
 * fast and is easy to audit. Scope: served from /sw.js => controls the whole
 * origin, which is what we need for notifications app-wide.
 */

self.addEventListener('install', (event) => {
  // Activate immediately so the first subscribe doesn't need a reload.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch (e) {
    data = { title: 'Omnidesk', body: event.data ? event.data.text() : '' }
  }

  const title = data.title || 'Omnidesk'
  const options = {
    body: data.body || 'New message received',
    icon: '/app-icon-192.png',
    badge: '/icon-light-32x32.png',
    tag: data.tag || undefined,
    // Replace an existing bubble with the same tag instead of stacking.
    renotify: Boolean(data.tag),
    data: { url: data.url || '/app/inbox' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const targetUrl =
    (event.notification.data && event.notification.data.url) || '/app/inbox'

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus an already-open panel tab if there is one.
        for (const client of clientList) {
          if ('focus' in client) {
            try {
              const url = new URL(client.url)
              if (url.pathname.startsWith('/app')) {
                client.focus()
                if ('navigate' in client) client.navigate(targetUrl)
                return
              }
            } catch (e) {
              /* ignore malformed client url */
            }
          }
        }
        // Otherwise open a new one.
        if (self.clients.openWindow) return self.clients.openWindow(targetUrl)
      }),
  )
})
