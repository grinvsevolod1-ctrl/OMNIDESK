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
    data: {
      url: data.url || '/app/inbox',
      kind: data.kind,
      kickToken: data.kickToken,
      conversationId: data.conversationId,
      replyRole: data.replyRole,
    },
  }

  // Security alert («вход с нового устройства»): action buttons + sticky, so
  // the manager must consciously dismiss it rather than it fading away.
  if (data.kind === 'security') {
    options.requireInteraction = true
    options.actions = [
      { action: 'confirm', title: 'Да, это я' },
      { action: 'kick', title: 'Разлогинить все' },
    ]
  } else if (data.conversationId) {
    // Inbound message: let the operator reply straight from the notification.
    // Android/Chrome renders a text input; platforms without inline-reply
    // support fall back to a plain button that just opens the chat.
    options.actions = [
      {
        action: 'reply',
        title: 'Ответить',
        type: 'text',
        placeholder: 'Сообщение…',
      },
    ]
  }

  event.waitUntil(showGated(data, title, options))
})

/**
 * Identity gate for message pushes.
 *
 * A Web Push subscription outlives the session: after sign-out (or a forced
 * "log out other devices", password change, or account block) the server row
 * can linger and the dispatcher keeps pushing to a device nobody is signed in
 * on — the "logged out but still getting notifications" bug. The service worker
 * is the only agent left on such a device, so it must decide here.
 *
 * Message pushes carry `userId` (the addressed operator). Before showing, ask
 * the server who is signed in on THIS device (/api/push/whoami re-validates the
 * session against the DB). If nobody — or a different user — is signed in, we
 * DON'T show the notification and detach this endpoint so deliveries stop for
 * good. Verification failures fail OPEN (still show) so a transient network
 * blip never hides a real message from the rightful owner. Pushes without a
 * userId (security alerts, visitor/god) are always shown.
 */
async function showGated(data, title, options) {
  if (!data || !data.userId) {
    return self.registration.showNotification(title, options)
  }

  let currentUserId // undefined = could not determine → fail open
  try {
    const res = await fetch('/api/push/whoami', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    if (res.ok) {
      const json = await res.json()
      currentUserId = json && json.userId ? json.userId : null
    }
  } catch (e) {
    currentUserId = undefined
  }

  // Only suppress when we POSITIVELY know the signed-in user differs (or none).
  if (currentUserId !== undefined && currentUserId !== data.userId) {
    try {
      const sub = await self.registration.pushManager.getSubscription()
      if (sub && sub.endpoint) {
        await fetch('/api/push/detach', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ endpoint: sub.endpoint }),
        }).catch(() => {})
      }
    } catch (e) {
      /* best-effort detach; nothing else to do */
    }
    return // do not reveal the previous account's notification
  }

  return self.registration.showNotification(title, options)
}

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

  // Inline reply from the notification (Android/Chrome text action). Post the
  // typed text to the panel with the session cookie so it's sent under the
  // operator's identity, then confirm with a lightweight bubble.
  if (event.action === 'reply' && nData.conversationId) {
    const text = (event.reply || '').trim()
    if (!text) return
    event.waitUntil(
      fetch('/api/push/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          conversationId: nData.conversationId,
          role: nData.replyRole || 'manager',
          text,
        }),
      })
        .then((res) => {
          if (!res.ok) throw new Error('reply failed')
          return self.registration.showNotification('Omnidesk', {
            body: 'Ответ отправлен',
            icon: '/app-icon-192.png',
            badge: '/icon-light-32x32.png',
            tag: nData.conversationId
              ? 'conv:' + nData.conversationId
              : undefined,
            renotify: false,
          })
        })
        .catch(() =>
          self.registration.showNotification('Omnidesk', {
            body: 'Не удалось отправить ответ. Откройте чат.',
            icon: '/app-icon-192.png',
            badge: '/icon-light-32x32.png',
          }),
        ),
    )
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
