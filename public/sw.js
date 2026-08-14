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

/**
 * The browser can rotate or expire a push subscription on its own (desktop
 * Chrome does this after updates / endpoint expiry). When that happens the
 * server keeps pushing to a dead endpoint and this device silently stops
 * receiving notifications until the panel is reopened. Re-subscribe with the
 * same VAPID key and hand both endpoints to the server so it can swap the row.
 */
self.addEventListener('pushsubscriptionchange', (event) => {
  const oldSub = event.oldSubscription
  const appServerKey =
    (event.oldSubscription &&
      event.oldSubscription.options &&
      event.oldSubscription.options.applicationServerKey) ||
    null
  if (!appServerKey) return // nothing to re-subscribe with

  event.waitUntil(
    self.registration.pushManager
      .subscribe({ userVisibleOnly: true, applicationServerKey: appServerKey })
      .then((newSub) =>
        fetch('/api/push/resubscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({
            oldEndpoint: oldSub ? oldSub.endpoint : null,
            subscription: newSub.toJSON(),
          }),
        }),
      )
      .catch(() => {
        /* panel-load resync (NotificationProvider) is the fallback */
      }),
  )
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
    data: { url: data.url || '/app/inbox', kind: data.kind, kickToken: data.kickToken },
  }

  // Security alert («вход с нового устройства»): action buttons + sticky, so
  // the manager must consciously dismiss it rather than it fading away.
  if (data.kind === 'security') {
    options.requireInteraction = true
    options.actions = [
      { action: 'confirm', title: 'Да, это я' },
      { action: 'kick', title: 'Разлогинить все' },
    ]
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const nData = event.notification.data || {}

  // Security-alert buttons. «Да, это я» just dismisses; «Разлогинить все»
  // POSTs the signed kick token — the server bumps session_version, which
  // instantly revokes every session AND every trusted-device pass. Works
  // even if THIS device's own session cookie is stale: auth is the token.
  if (nData.kind === 'security') {
    if (event.action === 'kick' && nData.kickToken) {
      event.waitUntil(
        fetch('/api/security/kick', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: nData.kickToken }),
        })
          .then(() =>
            self.registration.showNotification('Omnidesk', {
              body: 'Все устройства разлогинены. Смените пароль при следующем входе.',
              icon: '/app-icon-192.png',
              tag: 'security-kick-done',
            }),
          )
          .catch(() => {}),
      )
    }
    // 'confirm' or a plain click: nothing else to do.
    return
  }

  const targetUrl = nData.url || '/app/inbox'

  // Match tabs by the target's top-level path segment, so a manager push
  // (/app/...) focuses a panel tab and a god-messenger push
  // (/wijegniwjgwjog/...) focuses a messenger tab — not each other's.
  let targetBase = '/'
  try {
    targetBase = '/' + (new URL(targetUrl, self.location.origin).pathname.split('/')[1] || '')
  } catch (e) {
    /* keep default base */
  }

  event.waitUntil(
    self.clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        // Focus an already-open tab in the same section if there is one.
        for (const client of clientList) {
          if ('focus' in client) {
            try {
              const url = new URL(client.url)
              if (targetBase !== '/' && url.pathname.startsWith(targetBase)) {
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
