/* eslint-disable @typescript-eslint/no-unused-vars, @typescript-eslint/no-unused-expressions */
/*
 * Support chat browser SDK.
 *
 * ONE way to install it — add this single tag to any site, anywhere:
 *
 *      <script async src="https://YOUR_PANEL/widget.js"
 *              data-support-key="lc_xxx"></script>
 *
 * A floating button and chat panel are mounted automatically. Look & feel,
 * welcome message, quick replies, messengers, working hours and auto-open are
 * ALL configured remotely and fetched live from /api/livechat/config — so
 * editing the widget in the admin updates the live site without ever touching
 * the snippet again. The snippet only ever carries the key.
 *
 * Optionally control + observe the widget via the global object:
 *      SupportChat.open({ name, subject, message })  // open + prefill
 *      SupportChat.close()
 *      SupportChat.on('open',          () => { ... })
 *      SupportChat.on('close',         () => { ... })
 *      SupportChat.on('message_sent',  ({ body, count }) => { ... })
 *      SupportChat.on('first_message', ({ body }) => { ... })
 */
(function () {
  'use strict'

  // Resolve the panel origin from this script's own URL.
  var currentScript =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName('script')
      return s[s.length - 1]
    })()
  // The widget always talks to the panel it was loaded from. We derive the
  // panel origin straight from this script's own URL, so the same snippet works
  // on any site without per-site configuration.
  var DEFAULT_BASE = (function () {
    try {
      return new URL(currentScript.src).origin
    } catch (e) {
      return ''
    }
  })()

  /* ---------------------- Client-side config defaults ----------------- */

  // Mirrors lib/widget-config.ts defaultWidgetConfig() so the widget renders
  // sensibly before the server config arrives (and inside the admin preview).
  // Transient fallback config used only before the authoritative server config
  // arrives (the widget stays hidden until then) and in the admin preview. The
  // CANONICAL defaults live in `lib/widget-config.ts` -> defaultWidgetConfig().
  // Keep these values byte-for-byte in sync with that function so a slow first
  // /config response never flashes different copy than the server would send.
  function clientDefaultConfig() {
    return {
      appearance: {
        title: 'Чат поддержки',
        color: '#2563eb',
        greeting: '',
        greetingSub: 'Нажмите, чтобы начать',
        position: 'right',
        agentName: '',
        agentAvatar: '',
        subtitle: 'Мы на связи',
      },
      content: {
        welcomeMessage: 'Здравствуйте! Чем можем помочь?',
        quickReplies: [],
        inputPlaceholder: 'Введите сообщение...',
        showMessengers: false,
        messengersTitle: 'Или напишите в мессенджер',
      },
      messengers: [],
      workingHours: {
        enabled: true,
        tz: 'Europe/Moscow',
        startHour: 8,
        startMinute: 0,
        endHour: 17,
        endMinute: 0,
        days: [1, 2, 3, 4, 5],
      },
      offline: {
        title: 'Мы сейчас не работаем',
        text: 'Оставьте сообщение или напишите нам в мессенджер — мы ответим, как только вернёмся.',
      },
      autoOpen: { enabled: false, delaySec: 15 },
    }
  }

  // Shallow-merge a partial config from data-* attributes onto the defaults.
  function bootConfigFrom(opts) {
    var cfg = clientDefaultConfig()
    if (opts.title) cfg.appearance.title = opts.title
    if (opts.color) cfg.appearance.color = opts.color
    if (opts.greeting) cfg.appearance.greeting = opts.greeting
    if (opts.name) cfg.appearance.agentName = opts.name
    return cfg
  }

  function isHex(c) {
    return /^#[0-9a-fA-F]{6}$/.test(String(c || ''))
  }

  // Safe DOM insertion. On React/Next.js (and other) host pages the reference
  // node can be detached or re-parented out from under us when the framework
  // re-renders, which makes a raw parent.insertBefore(node, ref) throw
  // "NotFoundError: The node before which the new node is to be inserted is not
  // a child of this node." Guard every insert: only use insertBefore when ref is
  // truly a child of parent, otherwise fall back to appendChild.
  function safeInsertBefore(parent, node, ref) {
    if (!parent || !node) return
    try {
      if (ref && ref.parentNode === parent) {
        parent.insertBefore(node, ref)
      } else {
        parent.appendChild(node)
      }
    } catch (e) {
      try {
        parent.appendChild(node)
      } catch (e2) {}
    }
  }

  function waLink(raw) {
    var digits = String(raw || '').replace(/\D/g, '')
    if (digits.length < 7) return null
    return 'https://wa.me/' + digits
  }

  function storageKey(key) {
    return 'sc_uid_' + key
  }
  function legacyStorageKey(key) {
    return 'omnidesk_visitor_' + key
  }

  function getVisitorId(key) {
    var k = storageKey(key)
    try {
      var existing = localStorage.getItem(k)
      if (existing) return existing
      // Migrate a returning visitor from the legacy key so their identity (and
      // therefore their conversation history) is preserved across this update.
      var legacy = localStorage.getItem(legacyStorageKey(key))
      if (legacy) {
        localStorage.setItem(k, legacy)
        return legacy
      }
      var id =
        'v_' +
        (window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID().replace(/-/g, '')
          : Date.now().toString(36) + Math.random().toString(36).slice(2))
      localStorage.setItem(k, id)
      return id
    } catch (e) {
      return 'v_' + Date.now().toString(36)
    }
  }

  // Convert the server's URL-safe base64 VAPID public key into the Uint8Array
  // that pushManager.subscribe() requires as applicationServerKey.
  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4)
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
    var rawData = atob(base64)
    var outputArray = new Uint8Array(rawData.length)
    for (var i = 0; i < rawData.length; i++) {
      outputArray[i] = rawData.charCodeAt(i)
    }
    return outputArray
  }

  /* --------------------------- Core client --------------------------- */

  function collectMeta() {
    var meta = {}
    try {
      meta.language = navigator.language || ''
    } catch (e) {}
    try {
      meta.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''
    } catch (e) {}
    try {
      if (window.screen && window.screen.width) {
        meta.screen = window.screen.width + '×' + window.screen.height
      }
    } catch (e) {}
    try {
      meta.page = location.href || ''
    } catch (e) {}
    try {
      meta.referrer = document.referrer || ''
    } catch (e) {}
    return meta
  }

  function create(opts) {
    opts = opts || {}
    var key = opts.key
    if (!key) throw new Error('SupportChat: "key" is required')

    var apiBase = (opts.apiBase || DEFAULT_BASE || '').replace(/\/$/, '')
    var visitor = opts.visitor || getVisitorId(key)
    var name = opts.name || ''
    var meta = collectMeta()
    if (opts.subject) meta.subject = String(opts.subject)
    var onMessage = opts.onMessage || function () {}
    var onHistory = opts.onHistory || function () {}
    var onStatus = opts.onStatus || function () {}
    var onActive = opts.onActive || function () {}
    var onConfig = opts.onConfig || function () {}
    var onOffHours = opts.onOffHours || function () {}
    var onTyping = opts.onTyping || function () {}

    var listeners = {}
    var sentCount = 0
    function on(event, cb) {
      if (typeof cb !== 'function') return function () {}
      ;(listeners[event] = listeners[event] || []).push(cb)
      return function off() {
        listeners[event] = (listeners[event] || []).filter(function (f) {
          return f !== cb
        })
      }
    }
    function emit(event, payload) {
      ;(listeners[event] || []).forEach(function (cb) {
        try {
          cb(payload)
        } catch (e) {}
      })
    }

    var es = null
    var closedByUser = false
    var disabledByServer = false
    var retry = 0
    var configPoll = null
    // Liveness tracking: updated on every byte we hear from the server (events
    // AND heartbeats). A watchdog forces a reconnect if the stream goes quiet,
    // which recovers "zombie" connections a proxy silently dropped — the exact
    // cause of operator replies only showing up after a manual page refresh.
    var lastActivity = Date.now()
    var livenessTimer = null
    function markActivity() {
      lastActivity = Date.now()
    }

    function setStatus(s) {
      try {
        onStatus(s)
      } catch (e) {}
    }
    function setActive(active) {
      try {
        onActive(active)
      } catch (e) {}
    }

    function connect() {
      if (closedByUser || disabledByServer) return
      setStatus('connecting')
      var url =
        apiBase +
        '/api/livechat/stream?key=' +
        encodeURIComponent(key) +
        '&visitor=' +
        encodeURIComponent(visitor)
      try {
        es = new EventSource(url)
      } catch (e) {
        scheduleReconnect()
        return
      }

      es.onopen = function () {
        markActivity()
      }
      es.addEventListener('ready', function () {
        retry = 0
        markActivity()
        setStatus('online')
        setActive(true)
      })
      es.addEventListener('ping', markActivity)
      es.addEventListener('disabled', function () {
        disabledByServer = true
        if (es) {
          es.close()
          es = null
        }
        setStatus('offline')
        setActive(false)
      })
      es.addEventListener('history', function (ev) {
        markActivity()
        try {
          onHistory(JSON.parse(ev.data))
        } catch (e) {}
      })
      es.addEventListener('message', function (ev) {
        markActivity()
        try {
          onMessage(JSON.parse(ev.data))
        } catch (e) {}
      })
      es.addEventListener('typing', function (ev) {
        markActivity()
        try {
          var t = JSON.parse(ev.data)
          onTyping({ typing: t.typing !== false, author: t.author || '' })
        } catch (e) {}
      })
      es.onerror = function () {
        if (es && es.readyState === 2) {
          setStatus('offline')
          scheduleReconnect()
        } else {
          setStatus('connecting')
        }
      }
    }

    function scheduleReconnect() {
      if (closedByUser) return
      if (es) {
        es.close()
        es = null
      }
      retry++
      var delay = Math.min(1000 * Math.pow(2, retry), 30000)
      setTimeout(connect, delay)
    }

    // Immediate reconnect (resets backoff). Used by the liveness watchdog and on
    // tab-refocus / network-online so a stalled stream recovers at once and the
    // server replays history — pulling in any replies missed while it was dead.
    function forceReconnect() {
      if (closedByUser || disabledByServer) return
      if (es) {
        try {
          es.close()
        } catch (e) {}
        es = null
      }
      retry = 0
      markActivity()
      connect()
    }

    function send(text) {
      var body = String(text || '').trim()
      if (!body) return Promise.resolve({ ok: false, error: 'empty_message' })
      sentCount++
      emit('message_sent', { body: body, count: sentCount })
      if (sentCount === 1) {
        emit('first_message', { body: body })
        // First message creates the conversation — the visitor is looking at an
        // open chat right now, so begin reporting presence.
        basePresence = 'open'
        ensurePresenceHeartbeat()
        rawPresence(effectivePresence())
      }
      var url = apiBase + '/api/livechat/ingest'
      return fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          key: key,
          visitor: visitor,
          name: name,
          message: body,
          meta: meta,
        }),
      })
        .then(function (r) {
          return r
            .text()
            .then(function (raw) {
              try {
                return JSON.parse(raw)
              } catch (e) {
                return { ok: false, error: 'bad_response' }
              }
            })
        })
        .catch(function () {
          return { ok: false, error: 'network_error' }
        })
    }

    // Ephemeral "visitor is typing" ping (with a live draft preview) for the
    // manager's inbox. Throttled so we POST a "typing" at most every ~1.1s while
    // the visitor keeps writing; a "stopped" ping always goes out immediately.
    var lastTypingAt = 0
    function sendTyping(typing, draft) {
      if (closedByUser || disabledByServer) return
      var now = Date.now()
      if (typing) {
        if (now - lastTypingAt < 1100) return
        lastTypingAt = now
      } else {
        lastTypingAt = 0
      }
      try {
        fetch(apiBase + '/api/livechat/typing', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            key: key,
            visitor: visitor,
            name: name,
            typing: !!typing,
            draft: typing ? String(draft || '').slice(0, 500) : '',
          }),
          keepalive: true,
        }).catch(function () {})
      } catch (e) {}
    }

    // ----- Visitor presence (open / minimized / away / left) -----
    // Ephemeral, exactly like typing: tells the manager's inbox whether the
    // visitor is looking at the chat, has it minimized, switched tabs, or left
    // the page. Only meaningful once a conversation exists (after the first
    // message), so we gate every ping on sentCount and let the server no-op
    // otherwise. `basePresence` is the logical widget state (open/minimized);
    // tab visibility overrides it with 'away' without losing it.
    var basePresence = 'minimized'
    var presenceTimer = null

    function rawPresence(state, useBeacon) {
      if (closedByUser || disabledByServer) return
      if (sentCount < 1) return // no conversation yet → nobody to notify
      var u = apiBase + '/api/livechat/presence'
      var body = JSON.stringify({
        key: key,
        visitor: visitor,
        name: name,
        state: state,
      })
      if (useBeacon) {
        // Unload path: sendBeacon survives the page going away; fetch may not.
        try {
          if (navigator.sendBeacon) {
            navigator.sendBeacon(u, new Blob([body], { type: 'application/json' }))
            return
          }
        } catch (e) {}
      }
      try {
        fetch(u, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {})
      } catch (e) {}
    }

    // Effective state = logical widget state, unless the tab is hidden.
    function effectivePresence() {
      if (typeof document !== 'undefined' && document.hidden) return 'away'
      return basePresence
    }

    // Public: update the logical widget state (open/minimized) and ping now.
    function setPresence(state) {
      if (state === 'open' || state === 'minimized') basePresence = state
      ensurePresenceHeartbeat()
      rawPresence(effectivePresence())
    }

    // Heartbeat so the inbox can detect a silently-lost visitor (crash, network
    // drop) where the 'left' beacon never fired — it expires the indicator.
    function ensurePresenceHeartbeat() {
      if (presenceTimer || sentCount < 1) return
      presenceTimer = setInterval(function () {
        rawPresence(effectivePresence())
      }, 25000)
    }

    function disconnect() {
      closedByUser = true
      if (es) {
        es.close()
        es = null
      }
      if (configPoll) {
        clearInterval(configPoll)
        configPoll = null
      }
      if (livenessTimer) {
        clearInterval(livenessTimer)
        livenessTimer = null
      }
      if (presenceTimer) {
        clearInterval(presenceTimer)
        presenceTimer = null
      }
      setStatus('offline')
    }

    function setName(n) {
      name = n || ''
    }
    function setSubject(s) {
      if (s) meta.subject = String(s)
    }

    /* ------------------- Live config + working hours ----------------- */

    // The widget polls /api/livechat/config so admin edits (look, content,
    // messengers, working hours, auto-open) and the off-hours switch apply on
    // the live site without reinstalling the snippet.
    var lastOffState = null
    // VAPID public key for Web Push, delivered by /config (null when the server
    // has no push configured). Captured on each poll; used by subscribePush().
    var vapidPublicKey = null

    function trackMessenger(messenger) {
      if (messenger !== 'telegram' && messenger !== 'whatsapp') return
      var u = apiBase + '/api/livechat/track'
      var body = JSON.stringify({ key: key, messenger: messenger })
      try {
        if (navigator.sendBeacon) {
          navigator.sendBeacon(u, new Blob([body], { type: 'application/json' }))
          return
        }
      } catch (e) {}
      try {
        fetch(u, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: body,
          keepalive: true,
        }).catch(function () {})
      } catch (e) {}
    }

    function pollConfig() {
      fetch(apiBase + '/api/livechat/config?key=' + encodeURIComponent(key), {
        method: 'GET',
      })
        .then(function (r) {
          return r.json().catch(function () {
            return { ok: false }
          })
        })
        .then(function (res) {
          if (!res || res.ok === false) return
          if (res.config) {
            try {
              onConfig(res.config)
            } catch (e) {}
          }
          if (typeof res.vapidPublicKey !== 'undefined') {
            vapidPublicKey = res.vapidPublicKey || null
          }
          lastOffState = { offHours: !!res.offHours }
          try {
            onOffHours(lastOffState)
          } catch (e) {}
        })
        .catch(function () {})
    }

    // Subscribe this visitor to Web Push so operator replies reach them even
    // with no tab open. The subscription is created on the HOST site's own
    // service worker (sw.js) with our VAPID public key, then saved
    // server-side keyed by channel + visitor. Idempotent and self-silencing:
    // safe to call repeatedly (e.g. every time permission is (re)granted).
    function subscribePush() {
      try {
        if (!vapidPublicKey) return
        if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
        navigator.serviceWorker.ready
          .then(function (reg) {
            return reg.pushManager.getSubscription().then(function (existing) {
              if (existing) return existing
              return reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
              })
            })
          })
          .then(function (sub) {
            if (!sub) return
            var raw = sub.toJSON ? sub.toJSON() : sub
            return fetch(apiBase + '/api/livechat/push/subscribe', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                key: key,
                visitor: visitor,
                subscription: raw,
              }),
            }).catch(function () {})
          })
          .catch(function () {})
      } catch (e) {}
    }

    pollConfig()
    // Re-check every 15s so admin edits + the working-hours switch apply live.
    configPoll = setInterval(pollConfig, 15000)

    connect()

    // Liveness watchdog: the server pings every 20s, so if we've heard nothing
    // for ~50s the stream is dead even if the browser still thinks it's open.
    // Force a fresh connection (history replay recovers any missed replies).
    livenessTimer = setInterval(function () {
      if (closedByUser || disabledByServer) return
      if (Date.now() - lastActivity > 50000) {
        setStatus('connecting')
        forceReconnect()
      }
    }, 15000)

    // Reconnect the instant the visitor returns to the tab or the network comes
    // back — common moments when a backgrounded stream was silently dropped.
    function onWake() {
      if (closedByUser || disabledByServer) return
      if (typeof document !== 'undefined' && document.hidden) return
      if (!es || es.readyState !== 1 || Date.now() - lastActivity > 30000) {
        forceReconnect()
      }
      pollConfig()
    }
    try {
      document.addEventListener('visibilitychange', onWake)
      window.addEventListener('online', onWake)
      window.addEventListener('focus', onWake)
    } catch (e) {}

    // Presence transitions: tab hidden → 'away', tab visible → restore the
    // logical state; page unload → 'left' (sendBeacon, the only thing reliable
    // during teardown). All no-op until the visitor has sent a first message.
    try {
      document.addEventListener('visibilitychange', function () {
        rawPresence(effectivePresence())
      })
      var leave = function () {
        rawPresence('left', true)
      }
      window.addEventListener('pagehide', leave)
      window.addEventListener('beforeunload', leave)
    } catch (e) {}

    return {
      send: send,
      sendTyping: sendTyping,
      setPresence: setPresence,
      disconnect: disconnect,
      setName: setName,
      setSubject: setSubject,
      on: on,
      emit: emit,
      visitorId: visitor,
      trackMessenger: trackMessenger,
      pollConfig: pollConfig,
      subscribePush: subscribePush,
      getOffState: function () {
        return lastOffState
      },
    }
  }

  /* ------------------------------- Icons ----------------------------- */

  var ICON_MESSAGE =
    '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>'
  // Solid, friendly chat glyph for the launcher (filled reads as more premium /
  // tactile than a thin outline at small sizes). Two dots hint at a live reply.
  var ICON_LAUNCHER =
    '<svg width="27" height="27" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 3.2c-5.08 0-9.2 3.4-9.2 7.6 0 2.36 1.3 4.47 3.34 5.88.18.12.27.33.24.54l-.36 2.46c-.08.55.5.95.98.67l2.9-1.68c.16-.1.36-.13.55-.09.82.18 1.68.27 2.56.27 5.08 0 9.2-3.4 9.2-7.6S17.08 3.2 12 3.2Z"/><circle cx="9" cy="11" r="1.15" fill="#fff"/><circle cx="15" cy="11" r="1.15" fill="#fff"/></svg>'
  // Larger close glyph shown on the launcher itself while the panel is open.
  var ICON_LAUNCHER_CLOSE =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  var ICON_CLOSE =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>'
  var ICON_SEND =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>'
  var ICON_TELEGRAM =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M21.95 4.27 18.6 19.94c-.25 1.11-.92 1.38-1.86.86l-5.14-3.79-2.48 2.39c-.27.27-.5.5-1.03.5l.37-5.23 9.52-8.6c.41-.37-.09-.57-.64-.2L5.07 13.1l-5.07-1.59c-1.1-.34-1.12-1.1.23-1.63l19.8-7.63c.92-.34 1.72.2 1.42 1.62z" transform="translate(1 0)"/></svg>'
  var ICON_WHATSAPP =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M17.5 14.4c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.95 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.48-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.17.2-.3.3-.5.1-.2.05-.37-.02-.52-.08-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51l-.57-.01c-.2 0-.52.07-.8.37-.27.3-1.04 1.02-1.04 2.48 0 1.46 1.07 2.88 1.22 3.08.15.2 2.1 3.2 5.08 4.49.71.31 1.26.49 1.69.62.71.23 1.36.2 1.87.12.57-.08 1.77-.72 2.02-1.42.25-.7.25-1.3.17-1.42-.07-.13-.27-.2-.57-.35z"/></svg>'
  var ICON_LINK =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>'
  var ICON_CLOCK =
    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
  var ICON_BELL =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>'
  var ICON_CHECK =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>'
  var ICON_DOWNLOAD =
    '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>'
  // Inline iOS "Share" glyph (rendered inside running text in the gate card).
  var ICON_IOS_SHARE =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:-2px"><path d="M12 16V4"/><polyline points="8 8 12 4 16 8"/><path d="M5 12v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/></svg>'

  /* ------------------------- Drop-in widget UI ------------------------ */

  // Inject the widget's keyframe animations once per document. Inline styles
  // can't express @keyframes, so we add a single tagged <style> block. Guarded
  // by an id so repeated mounts (and the admin preview) don't duplicate it.
  function injectWidgetStyles(doc) {
    if (doc.getElementById('csw-styles')) return
    var style = doc.createElement('style')
    style.id = 'csw-styles'
    style.textContent =
      '@keyframes csw-pop{0%{opacity:0;transform:translateY(12px) scale(.96)}100%{opacity:1;transform:translateY(0) scale(1)}}' +
      '@keyframes csw-pop-out{0%{opacity:1;transform:translateY(0) scale(1)}100%{opacity:0;transform:translateY(12px) scale(.96)}}' +
      '@keyframes csw-fade-out{0%{opacity:1}100%{opacity:0}}' +
      '@keyframes csw-fade-up{0%{opacity:0;transform:translateY(8px)}100%{opacity:1;transform:translateY(0)}}' +
      '@keyframes csw-launch-in{0%{opacity:0;transform:scale(.5)}60%{transform:scale(1.08)}100%{opacity:1;transform:scale(1)}}' +
      '@keyframes csw-ring{0%{transform:scale(1);opacity:.5}100%{transform:scale(1.9);opacity:0}}' +
      '@keyframes csw-dot{0%,60%,100%{transform:translateY(0);opacity:.4}30%{transform:translateY(-4px);opacity:1}}' +
      '@keyframes csw-fs-in{0%{opacity:0;transform:scale(1.03)}100%{opacity:1;transform:scale(1)}}' +
      // Opacity-only variant for the centred desktop card: a transform-based
      // animation would clobber its translate(-50%,-50%) centring.
      '@keyframes csw-fs-fade{0%{opacity:0}100%{opacity:1}}' +
      '@keyframes csw-bell{0%,100%{transform:rotate(0)}20%{transform:rotate(-12deg)}40%{transform:rotate(10deg)}60%{transform:rotate(-6deg)}80%{transform:rotate(4deg)}}' +
      '.csw-bell-anim{animation:csw-bell 1.6s ease-in-out infinite;transform-origin:50% 4px}' +
      '.csw-bubble-in{animation:csw-fade-up .26s cubic-bezier(.21,1.02,.73,1) both}' +
      '.csw-typing span{display:inline-block;width:6px;height:6px;border-radius:50%;background:currentColor;margin:0 2px;animation:csw-dot 1.2s infinite ease-in-out}' +
      '.csw-typing span:nth-child(2){animation-delay:.15s}' +
      '.csw-typing span:nth-child(3){animation-delay:.3s}' +
      // Mobile: keep the panel comfortably inside the viewport instead of the
      // fixed 384×600 box (which is oversized on phones). Excludes the forced-
      // fullscreen state (.csw-fs) so the lock can still go edge-to-edge.
      // Breakpoint matches isMobileViewport() (640px) so panel sizing and the
      // lock's mobile behaviour switch at the same width. dvh (with a vh
      // fallback) tracks the *dynamic* viewport so mobile browser chrome
      // showing/hiding can't push the panel off-screen.
      '@media (max-width:640px){' +
      '[data-csw-panel]:not(.csw-fs){' +
      'width:calc(100vw - 24px) !important;' +
      'max-width:calc(100vw - 24px) !important;' +
      'height:70vh !important;' +
      'height:70dvh !important;' +
      'max-height:calc(100vh - 96px) !important;' +
      'max-height:calc(100dvh - 96px) !important;' +
      '}}' +
      // Respect the OS "reduce motion" preference: drop the looping pulse ring,
      // bell wobble and typing-dot bounce, and collapse one-shot animations to
      // an instant state change. Scoped to the widget so we never touch the host
      // page. The launcher/panel still appear — just without movement.
      '@media (prefers-reduced-motion: reduce){' +
      '[data-csw-widget] *,[data-csw-panel],[data-csw-panel] *{' +
      'animation-duration:.001ms !important;' +
      'animation-iteration-count:1 !important;' +
      'transition-duration:.001ms !important;' +
      'scroll-behavior:auto !important;' +
      '}}'
    ;(doc.head || doc.documentElement).appendChild(style)
  }

  function mountWidget(initial, options) {
    options = options || {}
    var preview = !!options.preview
    injectWidgetStyles(document)

    // Palette (slate "muted" bubbles, white card).
    var MUTED_BG = '#f1f5f9'
    var FG = '#0f172a'
    var MUTED_FG = '#64748b'
    var BORDER = '#e8ebf0'
    // Translucent tints derived from the configured brand colour (8-digit hex
    // alpha — widely supported). Used for soft, on-brand shadows and rings.
    function tint(hex, alphaHex) {
      return isHex(hex) ? hex + alphaHex : 'rgba(15,23,42,' + '.12)'
    }
    // Lighten (positive percent) or darken (negative) a hex colour. Used to
    // build the subtle brand gradient in the header. Falls back to the input.
    function shade(hex, percent) {
      if (!isHex(hex)) return hex
      var r = parseInt(hex.slice(1, 3), 16)
      var g = parseInt(hex.slice(3, 5), 16)
      var b = parseInt(hex.slice(5, 7), 16)
      var t = percent < 0 ? 0 : 255
      var p = Math.abs(percent) / 100
      function ch(c) {
        return Math.round((t - c) * p + c)
      }
      function hx(c) {
        var s = c.toString(16)
        return s.length === 1 ? '0' + s : s
      }
      return '#' + hx(ch(r)) + hx(ch(g)) + hx(ch(b))
    }

    var cfg = initial || clientDefaultConfig()
    var primary = isHex(cfg.appearance.color) ? cfg.appearance.color : '#2563eb'

    function formatTime(value) {
      var d = value ? new Date(value) : new Date()
      if (isNaN(d.getTime())) d = new Date()
      var h = d.getHours()
      var m = d.getMinutes()
      return (h < 10 ? '0' + h : h) + ':' + (m < 10 ? '0' + m : m)
    }

    /* ----- Root + launcher ----- */
    var root = document.createElement('div')
    root.setAttribute('data-csw-widget', '')
    // pointer-events:none so the full-width container never swallows taps in the
    // empty space around the widget (which blocked host-site buttons near it).
    // Each interactive child re-enables pointer-events:auto on itself.
    // Starts hidden (opacity:0) so it never flashes with default colour/position
    // before the real server config lands — it fades in once configured.
    root.style.cssText =
      'position:fixed;bottom:16px;z-index:2147483000;display:flex;flex-direction:column;align-items:flex-end;pointer-events:none;opacity:0;transition:opacity .28s ease;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif'

    // One-shot reveal. Called on the first real config (live mode), immediately
    // (preview mode), or by a safety timer if the network is slow/down.
    var revealed = false
    function revealWidget() {
      if (revealed) return
      revealed = true
      root.style.opacity = '1'
    }

    // Dimmed backdrop shown behind the panel when it expands (forced-fullscreen
    // lock). On desktop the panel becomes a large centred card over this scrim
    // rather than stretching edge-to-edge across the whole site.
    var backdrop = document.createElement('div')
    backdrop.style.cssText =
      'position:fixed;inset:0;background:rgba(15,23,42,.5);opacity:0;pointer-events:none;transition:opacity .28s ease;z-index:-1'

    // Launcher wrapper holds the button + an animated pulse ring behind it.
    var launcher = document.createElement('div')
    launcher.style.cssText = 'position:relative;width:62px;height:62px;pointer-events:auto'

    // Soft ambient halo behind the launcher — a calm, static brand glow that
    // adds depth without the old attention-grabbing pulse animation.
    var ring = document.createElement('span')
    ring.setAttribute('aria-hidden', 'true')
    ring.style.cssText =
      'position:absolute;inset:-7px;border-radius:50%;background:' +
      primary +
      ';opacity:.16;filter:blur(11px);pointer-events:none;transition:opacity .25s ease'

    var button = document.createElement('button')
    button.setAttribute('aria-label', 'Открыть чат')
    // Layered soft shadow (no harsh single drop) + calm scale on hover. The old
    // rotate-on-hover gimmick is gone for a more premium, restrained feel.
    var LAUNCHER_SHADOW =
      '0 12px 26px -8px ' + tint(primary, '73') + ',0 6px 14px -8px rgba(15,23,42,.28)'
    var LAUNCHER_SHADOW_HOVER =
      '0 18px 36px -8px ' + tint(primary, '94') + ',0 10px 20px -10px rgba(15,23,42,.34)'
    button.style.cssText =
      'position:relative;width:62px;height:62px;border-radius:50%;border:none;cursor:pointer;color:#fff;-webkit-tap-highlight-color:transparent;box-shadow:' +
      LAUNCHER_SHADOW +
      ';display:flex;align-items:center;justify-content:center;transition:transform .22s cubic-bezier(.34,1.4,.5,1),box-shadow .22s ease'
    button.innerHTML = ICON_LAUNCHER
    // Swap the launcher glyph between chat ⇄ close so the button doubles as the
    // open/close control, matching modern messenger widgets.
    function setLauncherIcon(open) {
      button.innerHTML = open ? ICON_LAUNCHER_CLOSE : ICON_LAUNCHER
    }
    button.addEventListener('mouseenter', function () {
      button.style.transform = 'scale(1.06)'
      button.style.boxShadow = LAUNCHER_SHADOW_HOVER
      ring.style.opacity = '.3'
    })
    button.addEventListener('mouseleave', function () {
      button.style.transform = 'scale(1)'
      button.style.boxShadow = LAUNCHER_SHADOW
      ring.style.opacity = '.16'
    })
    button.addEventListener('mousedown', function () {
      button.style.transform = 'scale(.94)'
    })
    button.addEventListener('mouseup', function () {
      button.style.transform = 'scale(1.06)'
    })
    // Small "online" pip on the launcher — a subtle, always-visible cue that
    // live support is available (raises trust + draws the eye). White ring so
    // it reads on any launcher colour.
    var launcherPip = document.createElement('span')
    launcherPip.setAttribute('aria-hidden', 'true')
    launcherPip.style.cssText =
      'position:absolute;top:1px;right:1px;width:14px;height:14px;border-radius:50%;background:#22c55e;border:2.5px solid #fff;box-shadow:0 1px 3px rgba(0,0,0,.2);pointer-events:none'
    // Unread counter badge — appears on the launcher when an operator replies
    // while the chat is closed/hidden. A strong, high-contrast cue that pulls
    // the visitor back into the conversation. Hidden (count 0) by default.
    var unreadBadge = document.createElement('span')
    unreadBadge.setAttribute('aria-hidden', 'true')
    unreadBadge.style.cssText =
      'position:absolute;top:-5px;right:-5px;min-width:20px;height:20px;padding:0 5px;border-radius:10px;background:#ef4444;color:#fff;font-size:12px;font-weight:700;line-height:20px;text-align:center;border:2px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.25);display:none;box-sizing:border-box'
    launcher.appendChild(ring)
    launcher.appendChild(button)
    launcher.appendChild(launcherPip)
    launcher.appendChild(unreadBadge)

    /* ----- Unread badge + chime (attention cues for a closed chat) ----- */
    var unreadCount = 0
    function renderUnread() {
      if (unreadCount > 0) {
        unreadBadge.textContent = unreadCount > 9 ? '9+' : String(unreadCount)
        unreadBadge.style.display = 'block'
        // Re-trigger a quick pop each time the count changes.
        unreadBadge.style.animation = 'none'
  unreadBadge.offsetWidth // force reflow so the animation restarts
        unreadBadge.style.animation = 'csw-launch-in .4s ease both'
        launcherPip.style.display = 'none' // badge supersedes the idle pip
      } else {
        unreadBadge.style.display = 'none'
        unreadBadge.style.animation = 'none'
        launcherPip.style.display = 'block'
      }
    }
    function bumpUnread() {
      unreadCount += 1
      renderUnread()
    }
    function clearUnread() {
      if (unreadCount !== 0) {
        unreadCount = 0
        renderUnread()
      }
    }

    // Tiny two-note chime synthesised on the fly — no audio file, no network,
    // and nothing to host. Best-effort: browsers may block it until the visitor
    // has interacted with the page (they have, by opening the chat).
    var audioCtx = null
    function playChime() {
      try {
        var AC = window.AudioContext || window.webkitAudioContext
        if (!AC) return
        if (!audioCtx) audioCtx = new AC()
        if (audioCtx.state === 'suspended') audioCtx.resume()
        var t = audioCtx.currentTime
        var o = audioCtx.createOscillator()
        var g = audioCtx.createGain()
        o.type = 'sine'
        o.frequency.setValueAtTime(660, t)
        o.frequency.setValueAtTime(880, t + 0.09)
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.12, t + 0.02)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.35)
        o.connect(g)
        g.connect(audioCtx.destination)
        o.start(t)
        o.stop(t + 0.36)
      } catch (e) {}
    }

    /* ----- Panel ----- */
    var panel = document.createElement('div')
    panel.setAttribute('data-csw-panel', '')
    panel.setAttribute('role', 'dialog')
    panel.setAttribute('aria-modal', 'false')
    panel.setAttribute('aria-label', 'Окно чата поддержки')
    // max-height uses dvh (dynamic viewport) with a vh fallback so the panel
    // never gets clipped by mobile browser chrome. transform-origin is set per
    // position (left/right) in applyConfig so the open animation grows from the
    // correct corner.
    panel.style.cssText =
      'pointer-events:auto;display:none;flex-direction:column;width:384px;max-width:calc(100vw - 32px);height:600px;max-height:80vh;max-height:80dvh;background:#fff;border:1px solid ' +
      BORDER +
      ';border-radius:26px;overflow:hidden;box-shadow:0 32px 64px -20px rgba(15,23,42,.26),0 12px 24px -12px rgba(15,23,42,.12),0 0 0 1px rgba(15,23,42,.04);margin-bottom:18px;transform-origin:bottom right'

    /* Header — brand gradient for a richer, more technological feel. */
    var header = document.createElement('div')
    header.style.cssText =
      'position:relative;padding:16px 18px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;overflow:hidden'

    // Very subtle top highlight for a hint of depth — far calmer than the old
    // oversized white radial blob, in line with a restrained premium look.
    var headerSheen = document.createElement('span')
    headerSheen.setAttribute('aria-hidden', 'true')
    headerSheen.style.cssText =
      'position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,.10) 0%,rgba(255,255,255,0) 55%);pointer-events:none'
    header.appendChild(headerSheen)

    var headerLeft = document.createElement('div')
    headerLeft.style.cssText =
      'position:relative;display:flex;align-items:center;gap:12px;min-width:0'

    // Avatar wrapper carries an online pip; the inner circle holds the
    // image/icon (overflow-clipped) so the pip is never cropped by the avatar.
    var avatarWrap = document.createElement('div')
    avatarWrap.style.cssText = 'position:relative;flex-shrink:0'
    var avatar = document.createElement('div')
    avatar.style.cssText =
      'width:42px;height:42px;border-radius:50%;background:rgba(255,255,255,.22);color:#fff;display:flex;align-items:center;justify-content:center;overflow:hidden;box-shadow:0 0 0 2px rgba(255,255,255,.35),0 2px 6px rgba(0,0,0,.12)'
    var avatarPip = document.createElement('span')
    avatarPip.setAttribute('aria-hidden', 'true')
    avatarPip.style.cssText =
      'position:absolute;bottom:0;right:0;width:11px;height:11px;border-radius:50%;background:#22c55e;border:2px solid #fff'
    avatarWrap.appendChild(avatar)
    avatarWrap.appendChild(avatarPip)

    var headerText = document.createElement('div')
    headerText.style.cssText = 'min-width:0'
    var headerTitle = document.createElement('div')
    headerTitle.style.cssText =
      'font-weight:700;color:#fff;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    var headerStatus = document.createElement('div')
    headerStatus.style.cssText =
      'display:flex;align-items:center;gap:6px;font-size:12px;color:rgba(255,255,255,.78)'
    var statusDot = document.createElement('span')
    statusDot.style.cssText =
      'width:7px;height:7px;border-radius:50%;background:#fbbf24;flex-shrink:0'
    var statusText = document.createElement('span')
    statusText.style.cssText =
      'white-space:nowrap;overflow:hidden;text-overflow:ellipsis'
    statusText.textContent = preview ? 'Онлайн' : 'Подключение…'
    headerStatus.appendChild(statusDot)
    headerStatus.appendChild(statusText)
    headerText.appendChild(headerTitle)
    headerText.appendChild(headerStatus)
    headerLeft.appendChild(avatarWrap)
    headerLeft.appendChild(headerText)

    var closeBtn = document.createElement('button')
    closeBtn.setAttribute('aria-label', 'Закрыть чат')
    closeBtn.style.cssText =
      'position:relative;width:32px;height:32px;border:none;cursor:pointer;border-radius:50%;background:rgba(255,255,255,.12);color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0;transition:background .15s ease'
    closeBtn.innerHTML = ICON_CLOSE
    closeBtn.addEventListener('mouseenter', function () {
      closeBtn.style.background = 'rgba(255,255,255,.22)'
    })
    closeBtn.addEventListener('mouseleave', function () {
      closeBtn.style.background = 'rgba(255,255,255,.12)'
    })
    header.appendChild(headerLeft)
    header.appendChild(closeBtn)

    /* Messages */
    var log = document.createElement('div')
    // Announce incoming messages to screen readers as they stream in, without
    // stealing focus. "polite" queues announcements after the current one.
    log.setAttribute('role', 'log')
    log.setAttribute('aria-live', 'polite')
    log.setAttribute('aria-atomic', 'false')
    log.setAttribute('aria-label', 'Сообщения чата')
    log.style.cssText =
      'flex:1;overflow-y:auto;padding:16px;background:#f8fafc;display:flex;flex-direction:column;gap:12px'

    var empty = document.createElement('div')
    empty.style.cssText =
      'margin:auto;text-align:center;color:' + MUTED_FG + ';font-size:14px;line-height:1.5'
    empty.textContent = 'Напишите нам — мы на связи.'

    /* Agent "is typing" indicator — animated dots + the agent's name. Lives at
       the bottom of the log and is shown only while an agent is composing. */
    var typingEl = document.createElement('div')
    typingEl.style.cssText =
      'display:none;align-self:flex-start;align-items:center;gap:8px;padding:10px 14px;border-radius:18px;border-bottom-left-radius:5px;background:' +
      MUTED_BG +
      ';color:' +
      MUTED_FG +
      ';font-size:13px;max-width:80%'
    var typingName = document.createElement('span')
    var typingDots = document.createElement('span')
    typingDots.className = 'csw-typing'
    typingDots.style.color = MUTED_FG
    typingDots.innerHTML = '<span></span><span></span><span></span>'
    typingEl.appendChild(typingDots)
    typingEl.appendChild(typingName)

    /* Inline messengers (working hours) */
    var inlineMsgr = document.createElement('div')
    inlineMsgr.style.cssText =
      'display:none;flex-direction:column;gap:8px;padding:12px 16px;border-top:1px solid ' +
      BORDER +
      ';background:#fff;flex-shrink:0'

    /* Quick replies */
    var quickRow = document.createElement('div')
    quickRow.style.cssText =
      'display:none;flex-wrap:wrap;gap:8px;padding:12px 16px 0;background:#fff;flex-shrink:0'

    /* Composer */
    var form = document.createElement('form')
    form.style.cssText =
      'display:flex;align-items:center;gap:10px;padding:14px 16px;border-top:1px solid ' +
      BORDER +
      ';background:#fff;flex-shrink:0'
    var input = document.createElement('input')
    input.type = 'text'
    input.placeholder = 'Введите сообщение...'
    input.setAttribute('aria-label', 'Сообщение')
    // font-size MUST be >=16px: iOS Safari force-zooms the page when a focused
    // input has a smaller font, which is jarring inside the widget.
    input.style.cssText =
      'flex:1;min-width:0;border:1px solid ' +
      BORDER +
      ';border-radius:22px;padding:12px 16px;font-size:16px;outline:none;background:' +
      MUTED_BG +
      ';color:' +
      FG +
      ';transition:border-color .15s ease,box-shadow .15s ease,background .15s ease'
    input.addEventListener('focus', function () {
      input.style.borderColor = primary
      input.style.background = '#fff'
      input.style.boxShadow = '0 0 0 3px ' + primary + '22'
    })
    input.addEventListener('blur', function () {
      input.style.borderColor = BORDER
      input.style.background = MUTED_BG
      input.style.boxShadow = 'none'
    })
    var sendBtn = document.createElement('button')
    sendBtn.type = 'submit'
    sendBtn.setAttribute('aria-label', 'Отправить')
    sendBtn.style.cssText =
      'border:none;border-radius:50%;width:46px;height:46px;align-self:center;flex-shrink:0;cursor:pointer;color:#fff;display:flex;align-items:center;justify-content:center;transition:transform .18s cubic-bezier(.34,1.56,.64,1),box-shadow .18s ease,filter .15s ease'
    sendBtn.addEventListener('mouseenter', function () {
      sendBtn.style.transform = 'translateY(-2px) scale(1.04)'
      sendBtn.style.filter = 'brightness(1.06)'
      sendBtn.style.boxShadow = '0 8px 18px ' + tint(primary, '5c')
    })
    sendBtn.addEventListener('mouseleave', function () {
      sendBtn.style.transform = 'none'
      sendBtn.style.filter = 'none'
      sendBtn.style.boxShadow = '0 4px 12px ' + tint(primary, '4d')
    })
    sendBtn.addEventListener('mousedown', function () {
      sendBtn.style.transform = 'translateY(0) scale(.96)'
    })
    sendBtn.innerHTML = ICON_SEND
    form.appendChild(input)
    form.appendChild(sendBtn)

    /* Off-hours view */
    var offView = document.createElement('div')
    offView.style.cssText =
      'display:none;flex:1;flex-direction:column;gap:16px;padding:24px 20px;overflow-y:auto;background:#fff'
    var offIcon = document.createElement('div')
    offIcon.style.cssText =
      'width:48px;height:48px;border-radius:14px;display:flex;align-items:center;justify-content:center;background:' +
      MUTED_BG +
      ';color:' +
      MUTED_FG
    offIcon.innerHTML = ICON_CLOCK
    var offTitle = document.createElement('div')
    offTitle.style.cssText = 'font-weight:700;font-size:16px;color:' + FG
    var offText = document.createElement('div')
    offText.style.cssText = 'font-size:14px;line-height:1.5;color:' + MUTED_FG
    var offBtns = document.createElement('div')
    offBtns.style.cssText = 'display:flex;flex-direction:column;gap:10px;margin-top:4px'
    offView.appendChild(offIcon)
    offView.appendChild(offTitle)
    offView.appendChild(offText)
    offView.appendChild(offBtns)

    log.appendChild(typingEl)

    panel.appendChild(header)
    panel.appendChild(log)
    panel.appendChild(inlineMsgr)
    panel.appendChild(quickRow)
    panel.appendChild(form)
    panel.appendChild(offView)

    /* Greeting teaser */
    var teaser = null

    root.appendChild(backdrop)
    root.appendChild(panel)
    root.appendChild(launcher)
    document.body.appendChild(root)

    /* ----- Messenger button builders ----- */
    function messengerHref(m) {
      if (m.type === 'whatsapp') return waLink(m.value)
      return m.value
    }
    function messengerIcon(type) {
      if (type === 'telegram') return ICON_TELEGRAM
      if (type === 'whatsapp') return ICON_WHATSAPP
      return ICON_LINK
    }
    function messengerColor(type) {
      if (type === 'telegram') return '#229ED9'
      if (type === 'whatsapp') return '#25D366'
      return primary
    }
    function messengerButton(m) {
      var href = messengerHref(m)
      if (!href) return null
      var a = document.createElement('a')
      a.href = href
      a.target = '_blank'
      a.rel = 'noopener noreferrer'
      a.setAttribute('aria-label', m.label)
      a.addEventListener('click', function () {
        if (preview) return
        if (m.type === 'telegram' || m.type === 'whatsapp') {
          chat.trackMessenger(m.type)
        }
      })
      a.style.cssText =
        'display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:14px;text-decoration:none;font-size:14px;font-weight:600;color:#fff;background:' +
        messengerColor(m.type) +
        ';transition:opacity .15s ease'
      a.addEventListener('mouseenter', function () {
        a.style.opacity = '.9'
      })
      a.addEventListener('mouseleave', function () {
        a.style.opacity = '1'
      })
      var ic = document.createElement('span')
      ic.style.cssText =
        'display:flex;align-items:center;justify-content:center;flex-shrink:0'
      ic.innerHTML = messengerIcon(m.type)
      var tx = document.createElement('span')
      tx.textContent = m.label
      a.appendChild(ic)
      a.appendChild(tx)
      return a
    }

    /* ----- Message bubbles ----- */
    var seen = {}
    function bubble(msg) {
      if (msg.id && seen[msg.id]) return
      if (msg.id) seen[msg.id] = true
      if (empty && empty.parentNode) empty.parentNode.removeChild(empty)
      var mine = msg.direction === 'in'
      var row = document.createElement('div')
      row.style.cssText =
        'display:flex;' + (mine ? 'justify-content:flex-end' : 'justify-content:flex-start')
      var el = document.createElement('div')
      el.className = 'csw-bubble-in'
      el.style.cssText =
        'max-width:82%;padding:10px 14px;font-size:14px;line-height:1.5;word-wrap:break-word;overflow-wrap:anywhere;border-radius:18px;' +
        (mine
          ? 'background:' +
            primary +
            ';color:#fff;border-bottom-right-radius:6px;box-shadow:0 3px 10px -2px ' +
            tint(primary, '38')
          : 'background:#fff;color:' +
            FG +
            ';border:1px solid ' +
            BORDER +
            ';border-bottom-left-radius:6px;box-shadow:0 1px 3px rgba(15,23,42,.05)')
      if (!mine && msg.author) {
        var who = document.createElement('div')
        who.style.cssText =
          'font-size:12px;font-weight:600;margin-bottom:4px;color:' + primary
        who.textContent = msg.author
        el.appendChild(who)
      }
      var body = document.createElement('div')
      body.style.cssText = 'white-space:pre-wrap'
      body.textContent = msg.body
      el.appendChild(body)
      var time = document.createElement('div')
      time.style.cssText =
        'font-size:12px;margin-top:4px;' +
        (mine ? 'color:rgba(255,255,255,.7)' : 'color:' + MUTED_FG)
      time.textContent = formatTime(msg.createdAt)
      el.appendChild(time)
      row.appendChild(el)
      // Keep the typing indicator pinned to the very bottom of the log.
      safeInsertBefore(log, row, typingEl)
      log.scrollTop = log.scrollHeight
    }

    /* Toggle the agent typing indicator. Called by the SSE 'typing' relay. */
    var typingHideTimer = null
    function showAgentTyping(on, author) {
      if (typingHideTimer) {
        clearTimeout(typingHideTimer)
        typingHideTimer = null
      }
      if (on) {
        if (empty && empty.parentNode) empty.parentNode.removeChild(empty)
        typingName.textContent = (author || 'Оператор') + ' печатает'
        typingEl.style.display = 'inline-flex'
        log.scrollTop = log.scrollHeight
        // Safety auto-hide if a "stopped" ping is ever lost.
        typingHideTimer = setTimeout(function () {
          typingEl.style.display = 'none'
        }, 6000)
      } else {
        typingEl.style.display = 'none'
      }
    }

    var lastNote = ''
    function systemNote(text) {
      if (!text || text === lastNote) return
      lastNote = text
      if (empty && empty.parentNode) empty.parentNode.removeChild(empty)
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:center'
      var el = document.createElement('div')
      el.style.cssText =
        'max-width:90%;padding:8px 14px;font-size:13px;line-height:1.45;text-align:center;border-radius:12px;background:' +
        MUTED_BG +
        ';color:' +
        MUTED_FG
      el.textContent = text
      row.appendChild(el)
      log.appendChild(row)
      log.scrollTop = log.scrollHeight
    }

    // Welcome bubble shown automatically (no agent message yet). Tagged so it
    // can be re-rendered when the config changes (preview / live edits).
    var welcomeEl = null
    var hasRealMessages = false
    function renderWelcome() {
      if (welcomeEl && welcomeEl.parentNode) {
        welcomeEl.parentNode.removeChild(welcomeEl)
        welcomeEl = null
      }
      var text = cfg.content.welcomeMessage
      if (!text || hasRealMessages) return
      if (empty && empty.parentNode) empty.parentNode.removeChild(empty)
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:flex-start'
      var el = document.createElement('div')
      el.style.cssText =
        'max-width:80%;padding:12px 16px;font-size:14px;line-height:1.5;border-radius:20px;border-bottom-left-radius:6px;background:#fff;border:1px solid ' +
        BORDER +
        ';box-shadow:0 2px 8px rgba(15,23,42,.06);color:' +
        FG
      var who = cfg.appearance.agentName || cfg.appearance.title
      if (who) {
        var w = document.createElement('div')
        w.style.cssText =
          'font-size:12px;font-weight:600;margin-bottom:4px;color:' + primary
        w.textContent = who
        el.appendChild(w)
      }
      var b = document.createElement('div')
      b.style.cssText = 'white-space:pre-wrap'
      b.textContent = text
      el.appendChild(b)
      row.appendChild(el)
      // Always keep the welcome at the very top of the log.
      safeInsertBefore(log, row, log.firstChild)
      welcomeEl = row
    }

    /* ----- Quick replies ----- */
    function renderQuickReplies() {
      quickRow.innerHTML = ''
      var items = cfg.content.quickReplies || []
      if (!items.length || offNow) {
        quickRow.style.display = 'none'
        return
      }
      items.forEach(function (q) {
        var chip = document.createElement('button')
        chip.type = 'button'
        chip.textContent = q
        chip.style.cssText =
          'border:1px solid ' +
          BORDER +
          ';background:#fff;color:' +
          FG +
          ';border-radius:9999px;padding:7px 13px;font-size:13px;cursor:pointer;transition:background .15s ease,border-color .15s ease'
        chip.addEventListener('mouseenter', function () {
          chip.style.background = MUTED_BG
          chip.style.borderColor = primary
        })
        chip.addEventListener('mouseleave', function () {
          chip.style.background = '#fff'
          chip.style.borderColor = BORDER
        })
        chip.addEventListener('click', function () {
          input.value = q
          input.focus()
        })
        quickRow.appendChild(chip)
      })
      quickRow.style.display = 'flex'
    }

    /* ----- Inline messengers (working hours) ----- */
    function renderInlineMessengers() {
      inlineMsgr.innerHTML = ''
      var show =
        cfg.content.showMessengers &&
        (cfg.messengers || []).length > 0 &&
        !offNow
      if (!show) {
        inlineMsgr.style.display = 'none'
        return
      }
      var title = document.createElement('div')
      title.style.cssText =
        'font-size:12px;font-weight:600;color:' + MUTED_FG
      title.textContent = cfg.content.messengersTitle || 'Мессенджеры'
      inlineMsgr.appendChild(title)
      cfg.messengers.forEach(function (m) {
        var btn = messengerButton(m)
        if (btn) inlineMsgr.appendChild(btn)
      })
      inlineMsgr.style.display = 'flex'
    }

    /* ----- Off-hours messengers ----- */
    function renderOffMessengers() {
      offBtns.innerHTML = ''
      var list = cfg.messengers || []
      var any = false
      list.forEach(function (m) {
        var btn = messengerButton(m)
        if (btn) {
          offBtns.appendChild(btn)
          any = true
        }
      })
      if (!any) {
        var hint = document.createElement('div')
        hint.style.cssText = 'font-size:13px;line-height:1.5;color:' + MUTED_FG
        hint.textContent =
          'Оставьте сообщение — мы ответим, как только вернёмся.'
        offBtns.appendChild(hint)
      }
    }

    /* ----- Apply config (idempotent; safe to call on every poll) ----- */
    var offNow = false
    function applyConfig(next) {
      cfg = next || cfg
      primary = isHex(cfg.appearance.color) ? cfg.appearance.color : '#2563eb'

      // Position. transform-origin follows the side so the open animation grows
      // out of the launcher's corner (was hardcoded bottom-right, which looked
      // wrong for left-positioned widgets).
      if (cfg.appearance.position === 'left') {
        root.style.left = '16px'
        root.style.right = 'auto'
        root.style.alignItems = 'flex-start'
        panel.style.transformOrigin = 'bottom left'
      } else {
        root.style.right = '16px'
        root.style.left = 'auto'
        root.style.alignItems = 'flex-end'
        panel.style.transformOrigin = 'bottom right'
      }

      // Colors. The header uses a subtle brand gradient (top-lighter →
      // bottom-base) for depth; everything else stays on the flat brand colour.
      header.style.background =
        'linear-gradient(160deg,' +
        shade(primary, 8) +
        ' 0%,' +
        primary +
        ' 100%)'
      // Launcher + send share a soft brand gradient (lighter top-left →
      // slightly darker bottom-right) for a tactile, dimensional look instead
      // of a flat fill. GPU-cheap: just a background, no blur/filters.
      var brandGrad =
        'linear-gradient(135deg,' +
        shade(primary, 14) +
        ' 0%,' +
        primary +
        ' 55%,' +
        shade(primary, -14) +
        ' 100%)'
      button.style.background = brandGrad
      ring.style.background = primary
      sendBtn.style.background = brandGrad
      sendBtn.style.boxShadow = '0 4px 12px ' + tint(primary, '4d')

      // Header text + avatar.
      headerTitle.textContent = cfg.appearance.title || 'Чат поддержки'
      if (cfg.appearance.agentAvatar) {
        avatar.innerHTML = ''
        var img = document.createElement('img')
        // Fall back to the default icon if the avatar URL fails to load, so we
        // never leave an empty circle.
        img.onerror = function () {
          avatar.innerHTML = ICON_MESSAGE
        }
        img.src = cfg.appearance.agentAvatar
        img.alt = cfg.appearance.agentName || 'Агент'
        img.style.cssText = 'width:100%;height:100%;object-fit:cover'
        avatar.appendChild(img)
      } else {
        avatar.innerHTML = ICON_MESSAGE
      }

      // Composer placeholder.
      input.placeholder = cfg.content.inputPlaceholder || 'Введите сообщение...'

      // Offline copy.
      offTitle.textContent = cfg.offline.title || 'Мы сейчас не работаем'
      offText.textContent = cfg.offline.text || ''

      // Greeting teaser.
      syncTeaser()

      // Dynamic blocks.
      renderWelcome()
      renderQuickReplies()
      renderInlineMessengers()
      renderOffMessengers()

      // Auto-open (live mode only).
      maybeScheduleAutoOpen()
    }

    function defaultStatusLine() {
      return cfg.appearance.subtitle || 'Мы на связи'
    }

    /* ----- Teaser sync ----- */
    function syncTeaser() {
      var text = cfg.appearance.greeting
      if (!text) {
        if (teaser && teaser.parentNode) teaser.parentNode.removeChild(teaser)
        teaser = null
        return
      }
      if (!teaser) {
        teaser = document.createElement('button')
        teaser.type = 'button'
        teaser.style.cssText =
          'pointer-events:auto;display:flex;flex-direction:column;align-items:flex-start;gap:3px;max-width:250px;margin-bottom:14px;padding:13px 16px;border:1px solid ' +
          BORDER +
          ';border-radius:18px;border-bottom-right-radius:6px;background:#fff;color:' +
          FG +
          ';box-shadow:0 16px 36px -14px rgba(15,23,42,.22),0 2px 6px -2px rgba(15,23,42,.08);cursor:pointer;text-align:left;font-size:14px;transition:transform .2s cubic-bezier(.34,1.56,.64,1),box-shadow .2s ease;animation:csw-pop .3s cubic-bezier(.21,1.02,.73,1) both'
        teaser._title = document.createElement('span')
        teaser._title.style.cssText = 'font-weight:600'
        teaser._sub = document.createElement('span')
        teaser._sub.style.cssText = 'font-size:12px;color:' + MUTED_FG
        teaser.appendChild(teaser._title)
        teaser.appendChild(teaser._sub)
        teaser.addEventListener('mouseenter', function () {
          teaser.style.transform = 'translateY(-3px)'
          teaser.style.boxShadow =
            '0 16px 40px -8px ' +
            tint(primary, '40') +
            ',0 0 0 1px ' +
            tint(primary, '26')
        })
        teaser.addEventListener('mouseleave', function () {
          teaser.style.transform = 'translateY(0)'
          teaser.style.boxShadow =
            '0 12px 32px -8px rgba(15,23,42,.22),0 0 0 1px rgba(15,23,42,.03)'
        })
        teaser.addEventListener('click', function () {
          openChat()
        })
        safeInsertBefore(root, teaser, launcher)
        if (!preview && (!activeConfirmed || teaserDismissed)) {
          teaser.style.display = 'none'
        }
      }
      teaser.setAttribute('aria-label', text)
      teaser._title.textContent = text
      teaser._sub.textContent = cfg.appearance.greetingSub || ''
    }

    /* ----- Off-hours toggle ----- */
    var lastOffApplied = null
    function applyOffHours(state) {
      var off = !!(state && state.offHours)
      offNow = off
      if (off) {
        form.style.display = 'none'
        log.style.display = 'none'
        inlineMsgr.style.display = 'none'
        quickRow.style.display = 'none'
        offView.style.display = 'flex'
        statusText.textContent = 'Не работаем'
        statusDot.style.background = '#f87171'
        renderOffMessengers()
      } else {
        offView.style.display = 'none'
        log.style.display = 'flex'
        form.style.display = 'flex'
        renderQuickReplies()
        renderInlineMessengers()
        if (preview) {
          statusText.textContent = defaultStatusLine()
          statusDot.style.background = '#4ade80'
        }
      }
      lastOffApplied = off
    }

    /* ----- Active gate + launcher ----- */
    // Show the launcher optimistically as soon as the widget mounts. We used to
    // keep it hidden until the SSE stream confirmed "ready", but that made the
    // whole widget invisible whenever the stream was slow, buffered by a proxy/
    // CDN, or briefly failed — even though the channel was perfectly valid. Now
    // the button always appears and we only HIDE it if the server explicitly
    // tells us the channel is disabled (the 'disabled' SSE event → onActive(false)).
    var activeConfirmed = true
    var teaserDismissed = false

    function showLauncher() {
      activeConfirmed = true
      launcher.style.display = 'block'
      button.style.animation =
        'csw-launch-in .4s cubic-bezier(.34,1.56,.64,1) both'
      if (teaser && !teaserDismissed) teaser.style.display = 'flex'
      maybeScheduleAutoOpen()
    }
    function hideLauncher() {
      activeConfirmed = false
      launcher.style.display = 'none'
      if (teaser) teaser.style.display = 'none'
    }

    /* ----- Auto-open ----- */
    var autoOpenTimer = null
    var autoOpenDone = false
    function maybeScheduleAutoOpen() {
      if (preview || autoOpenDone || autoOpenTimer) return
      if (!activeConfirmed) return
      if (!cfg.autoOpen || !cfg.autoOpen.enabled) return
      var delay = Math.max(1, cfg.autoOpen.delaySec || 15) * 1000
      autoOpenTimer = setTimeout(function () {
        autoOpenTimer = null
        autoOpenDone = true
        if (!isOpen && !offNow) openChat()
      }, delay)
    }

    /* ----- Chat client (or preview stub) ----- */
    var chat
    if (preview) {
      var bus = {}
      chat = {
        send: function () {
          return Promise.resolve({ ok: true })
        },
        sendTyping: function () {},
        disconnect: function () {},
        setName: function () {},
        setSubject: function () {},
        on: function (e, cb) {
          ;(bus[e] = bus[e] || []).push(cb)
          return function () {}
        },
        emit: function (e, p) {
          ;(bus[e] || []).forEach(function (cb) {
            try {
              cb(p)
            } catch (err) {}
          })
        },
        trackMessenger: function () {},
        getOffState: function () {
          return null
        },
      }
    } else {
      chat = create({
        key: initial && initial.__key,
        name: cfg.appearance.agentName,
        subject: initial && initial.__subject,
        onHistory: function (msgs) {
          log.innerHTML = ''
          seen = {}
          welcomeEl = null
          hasRealMessages = !!(msgs && msgs.length)
          // If the operator already replied in a previous session, never lock.
          if (msgs && msgs.length) {
            for (var i = 0; i < msgs.length; i++) {
              if (msgs[i] && msgs[i].direction === 'out') {
                operatorReplied = true
                break
              }
            }
          }
          if (!msgs || !msgs.length) {
            renderWelcome()
            if (!cfg.content.welcomeMessage) log.appendChild(empty)
          } else {
            msgs.forEach(bubble)
          }
        },
        onMessage: function (msg) {
          lastNote = ''
          hasRealMessages = true
          if (welcomeEl && welcomeEl.parentNode) {
            welcomeEl.parentNode.removeChild(welcomeEl)
            welcomeEl = null
          }
          bubble(msg)
          // An operator reply lifts the trap (but keeps the expanded view) and,
          // if the visitor stepped away with notifications on, pings them.
          if (msg && msg.direction === 'out') {
            operatorReplied = true
            releaseLock()
            fireReplyNotification(msg)
            // Reply landed while the visitor isn't actively watching → badge +
            // chime to pull them back. When the panel is open and visible we
            // stay silent (they already see it).
            if (!isOpen || document.hidden) {
              bumpUnread()
              playChime()
            }
          }
        },
        onStatus: function (s) {
          if (offNow) return
          statusText.textContent =
            s === 'online'
              ? defaultStatusLine()
              : s === 'connecting'
                ? 'Подключение…'
                : 'Не в сети'
          statusDot.style.background =
            s === 'online' ? '#4ade80' : s === 'connecting' ? '#fbbf24' : '#f87171'
        },
        onConfig: function (next) {
          applyConfig(next)
          // First real server config has landed and been painted — now it's
          // safe to fade the widget in without a colour/position flash.
          revealWidget()
        },
        onOffHours: function (state) {
          applyOffHours(state)
        },
        onTyping: function (t) {
          showAgentTyping(t && t.typing, t && t.author)
        },
        onActive: function (active) {
          if (active) {
            showLauncher()
          } else {
            if (isOpen) closeChat()
            hideLauncher()
          }
        },
      })
    }

    /* ----- Open / close ----- */
    var isOpen = false
    // Returning to the tab with the chat already open means the visitor can see
    // any reply that arrived while hidden — clear the unread cue.
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', function () {
        if (!document.hidden && isOpen) clearUnread()
      })
    }
    // Forced-fullscreen lock state (see the block below the open/close fns).
    var locked = false
    var canDismiss = false
    var notifyEnabled = false
    var lockTimer = null
    function hideTeaser() {
      teaserDismissed = true
      if (teaser && teaser.parentNode) teaser.parentNode.removeChild(teaser)
      teaser = null
    }
    function openChat(prefill) {
      if (!activeConfirmed) return
      hideTeaser()
      if (prefill && typeof prefill === 'object') {
        if (prefill.name) chat.setName(prefill.name)
        if (prefill.subject) chat.setSubject(prefill.subject)
        if (prefill.message) input.value = prefill.message
      }
      if (isOpen) {
        input.focus()
        return
      }
      isOpen = true
      clearUnread()
      panel.style.display = 'flex'
      panel.style.animation = 'csw-pop .28s cubic-bezier(.21,1.02,.73,1) both'
      // Show the welcome bubble on first open if the thread is empty.
      if (!hasRealMessages) renderWelcome()
      button.setAttribute('aria-label', 'Свернуть чат')
      setLauncherIcon(true)
      input.focus()
      chat.emit('open', {})
      // Tell the inbox the visitor is actively looking at the chat (no-op until
      // they've sent a first message and a conversation exists).
      try {
        chat.setPresence('open')
      } catch (e) {}
    }
    function closeChat() {
      if (!isOpen) return
      // While locked (awaiting the first operator reply) the chat can't be
      // dismissed — unless the visitor unlocked an exit by enabling notifications.
      if (locked && !canDismiss) return
      // Mark closed up front. Without this the panel keeps display:flex while the
      // pop-out animation leaves it at opacity:0 (fill mode "both"), so an
      // invisible panel stays mounted, swallows taps over its box (blocking the
      // host site) and prevents reopening because isOpen never flips back.
      isOpen = false
      button.setAttribute('aria-label', 'Открыть чат')
      setLauncherIcon(false)
      // Return focus to the launcher for keyboard users — but only if focus was
      // inside the panel, so a mouse/touch close doesn't yank focus or scroll.
      try {
        if (panel.contains(document.activeElement)) button.focus()
      } catch (e) {}
      // If the panel was expanded (centred card / mobile fullscreen) a
      // translate-based pop-out would fight its centring transform and jump, so
      // fade it out instead. Either way we reset to the docked bubble afterward.
      var expanded = false
      try {
        expanded = panel.classList.contains('csw-fs')
      } catch (e) {}
      if (expanded) hideBackdrop()
      panel.style.animation = expanded
        ? 'csw-fade-out .2s ease both'
        : 'csw-pop-out .2s cubic-bezier(.4,0,1,1) both'
      var done = function () {
        if (isOpen) return
        panel.style.display = 'none'
        panel.style.animation = 'none'
        // Reset any expanded sizing so the next open is the normal docked bubble.
        if (panel.classList.contains('csw-fs')) exitFullscreen()
        panel.removeEventListener('animationend', done)
      }
      panel.addEventListener('animationend', done)
      // Fallback: animationend can fail to fire (reduced-motion, hidden tab,
      // interrupted animation) — guarantee the panel is hidden regardless.
      setTimeout(done, 320)
      chat.emit('close', {})
      // Visitor closed the chat but is still on the page → minimized.
      try {
        chat.setPresence('minimized')
      } catch (e) {}
    }
    function toggle() {
      isOpen ? closeChat() : openChat()
    }
    button.addEventListener('click', toggle)
    closeBtn.addEventListener('click', closeChat)
    // Click the dimmed scrim to dismiss (closeChat self-guards: it's a no-op
    // while the visitor is still locked awaiting the first operator reply).
    backdrop.addEventListener('click', closeChat)

    // ----- Keyboard accessibility: focus trap + Esc to close -----
    // Visible, enabled, focusable elements inside the panel, in DOM order.
    function panelFocusables() {
      try {
        var nodes = panel.querySelectorAll(
          'button,[href],input,textarea,select,[tabindex]:not([tabindex="-1"])',
        )
        return Array.prototype.filter.call(nodes, function (el) {
          return (
            !el.disabled &&
            el.offsetParent !== null &&
            el.getAttribute('aria-hidden') !== 'true'
          )
        })
      } catch (e) {
        return []
      }
    }
    panel.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' || e.key === 'Esc') {
        // Esc closes — closeChat() self-guards while locked, so this is safe.
        if (!(locked && !canDismiss)) {
          e.stopPropagation()
          closeChat()
        }
        return
      }
      if (e.key !== 'Tab') return
      // Keep Tab focus cycling inside the open panel so keyboard users can't
      // tab out into the (often hidden) host page behind it.
      var items = panelFocusables()
      if (!items.length) return
      var first = items[0]
      var last = items[items.length - 1]
      var active = document.activeElement
      if (e.shiftKey) {
        if (active === first || !panel.contains(active)) {
          e.preventDefault()
          last.focus()
        }
      } else if (active === last || !panel.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    })

    /* ---------- Forced fullscreen lock until the operator replies --------- */
    // Product rule: the moment the visitor sends a message we take over the
    // whole screen (desktop + mobile) and remove the close affordance, holding
    // them in the conversation until an operator answers. The humane escape
    // hatch is browser notifications — if the wait runs long we offer to notify
    // them so they can step away and still receive the reply.
    // Surfaced quickly (not after a long trap): the install/push card is the
    // humane escape hatch, letting the visitor enable notifications and step
    // away while still receiving the reply.
    var NOTIFY_DELAY_MS = 2500
    var operatorReplied = false
    var notifyCardEl = null

    function supportsNotifications() {
      try {
        return 'Notification' in window
      } catch (e) {
        return false
      }
    }

    // ----- Native device fullscreen (like pressing F11) -----
    // Requesting the real Fullscreen API takes over the entire screen, hiding
    // the browser chrome and the rest of the page. It must be called from a
    // user gesture — message submit qualifies, so we trigger it there.
    function nativeFsElement() {
      return (
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement ||
        null
      )
    }
    function requestDeviceFullscreen() {
      try {
        var el = panel
        var fn =
          el.requestFullscreen ||
          el.webkitRequestFullscreen ||
          el.mozRequestFullScreen ||
          el.msRequestFullscreen
        if (fn && !nativeFsElement()) {
          var p = fn.call(el, { navigationUI: 'hide' })
          // Some engines reject with a non-Error; swallow it so we silently
          // fall back to the fixed-overlay fullscreen below.
          if (p && typeof p.catch === 'function') p.catch(function () {})
        }
      } catch (e) {}
    }
    function exitDeviceFullscreen() {
      try {
        if (!nativeFsElement()) return
        var fn =
          document.exitFullscreen ||
          document.webkitExitFullscreen ||
          document.mozCancelFullScreen ||
          document.msExitFullscreen
        if (fn) {
          var p = fn.call(document)
          if (p && typeof p.catch === 'function') p.catch(function () {})
        }
      } catch (e) {}
    }

    function isMobileViewport() {
      try {
        return (
          window.matchMedia && window.matchMedia('(max-width:640px)').matches
        )
      } catch (e) {
        return (window.innerWidth || 1024) <= 640
      }
    }

    function showBackdrop() {
      backdrop.style.zIndex = '0'
      backdrop.style.pointerEvents = 'auto'
      backdrop.style.opacity = '1'
    }
    function hideBackdrop() {
      backdrop.style.opacity = '0'
      backdrop.style.pointerEvents = 'none'
      backdrop.style.zIndex = '-1'
    }

    function enterFullscreen() {
      // Mark expanded so the mobile media query stops constraining the panel.
      try {
        panel.classList.add('csw-fs')
      } catch (e) {}
      panel.style.position = 'fixed'
      panel.style.zIndex = '1'
      panel.style.margin = '0'
      panel.style.border = 'none'
      panel.style.background = '#fff'

      if (isMobileViewport()) {
        // Phones: take the full viewport — comfortable for reading on a small
        // screen — and request the real device fullscreen to hide browser chrome.
        panel.style.top = '0'
        panel.style.left = '0'
        panel.style.right = '0'
        panel.style.bottom = '0'
        panel.style.transform = 'none'
        panel.style.width = '100%'
        panel.style.height = '100%'
        panel.style.maxWidth = 'none'
        panel.style.maxHeight = 'none'
        panel.style.borderRadius = '0'
        panel.style.boxShadow = 'none'
        requestDeviceFullscreen()
      } else {
        // Desktop: a large, comfortable centred card over a dimmed backdrop —
        // NOT stretched edge-to-edge across the whole site.
        panel.style.top = '50%'
        panel.style.left = '50%'
        panel.style.right = 'auto'
        panel.style.bottom = 'auto'
        panel.style.transform = 'translate(-50%,-50%)'
        panel.style.width = 'min(560px,94vw)'
        panel.style.height = 'min(720px,88vh)'
        panel.style.maxWidth = 'none'
        panel.style.maxHeight = 'none'
        panel.style.borderRadius = '22px'
        panel.style.boxShadow = '0 24px 70px rgba(15,23,42,.35)'
      }
      showBackdrop()
      // Mobile keeps the scale-in; the centred desktop card fades only so its
      // translate(-50%,-50%) centring isn't overridden by the animation.
      panel.style.animation = isMobileViewport()
        ? 'csw-fs-in .32s cubic-bezier(.21,1.02,.73,1) both'
        : 'csw-fs-fade .26s ease both'
    }
    function exitFullscreen() {
      exitDeviceFullscreen()
      hideBackdrop()
      try {
        panel.classList.remove('csw-fs')
      } catch (e) {}
      panel.style.background = ''
      panel.style.position = ''
      panel.style.zIndex = ''
      panel.style.top = ''
      panel.style.left = ''
      panel.style.right = ''
      panel.style.bottom = ''
      panel.style.transform = ''
      panel.style.boxShadow = ''
      panel.style.width = '384px'
      panel.style.height = '600px'
      panel.style.maxWidth = 'calc(100vw - 32px)'
      panel.style.maxHeight = '80vh'
      panel.style.margin = '0 0 14px 0'
      panel.style.borderRadius = '20px'
      panel.style.border = '1px solid ' + BORDER
      panel.style.animation = 'none'
    }

    function updateLockUI() {
      var hideClose = locked && !canDismiss
      closeBtn.style.display = hideClose ? 'none' : 'flex'
      // The launcher sits behind the fullscreen panel; hide it while locked so
      // it never peeks through on odd viewport sizes.
      launcher.style.visibility = locked ? 'hidden' : 'visible'
    }

    // Gentle "please wait for an operator" banner, pinned under the header
    // while the visitor is waiting for the first reply. Removed the moment the
    // operator answers.
    var waitNoticeEl = null
    function showWaitNotice() {
      if (waitNoticeEl || operatorReplied || offNow) return
      waitNoticeEl = document.createElement('div')
      waitNoticeEl.style.cssText =
        'flex-shrink:0;display:flex;align-items:center;gap:10px;padding:11px 16px;border-bottom:1px solid ' +
        BORDER +
        ';background:' +
        tint(primary, '12') +
        ';color:' +
        FG +
        ';animation:csw-fade-up .3s cubic-bezier(.21,1.02,.73,1) both'
      var ic = document.createElement('span')
      ic.style.cssText =
        'flex-shrink:0;display:flex;color:' + primary
      ic.innerHTML = ICON_CLOCK.replace('width="24" height="24"', 'width="18" height="18"')
      var tx = document.createElement('div')
      tx.style.cssText = 'font-size:13px;line-height:1.4;font-weight:500'
      tx.textContent =
        'Пожалуйста, дождитесь ответа нашего специалиста — он сейчас ответит.'
      waitNoticeEl.appendChild(ic)
      waitNoticeEl.appendChild(tx)
      safeInsertBefore(panel, waitNoticeEl, log)
    }
    function hideWaitNotice() {
      if (waitNoticeEl && waitNoticeEl.parentNode) {
        waitNoticeEl.parentNode.removeChild(waitNoticeEl)
      }
      waitNoticeEl = null
    }

    function enterLock() {
      if (preview || locked || operatorReplied || offNow) return
      locked = true
      canDismiss = false
      if (!isOpen) openChat()
      enterFullscreen()
      showWaitNotice()
      updateLockUI()
      if (lockTimer) clearTimeout(lockTimer)
      lockTimer = setTimeout(function () {
        if (locked && !notifyCardEl) showNotifyCard()
      }, NOTIFY_DELAY_MS)
    }

    // Operator replied: lift the trap (restore the close button, stop forcing
    // fullscreen re-entry) but KEEP the comfortable expanded view — collapsing
    // it the instant a reply lands is jarring, especially on mobile. The view
    // resets to the docked bubble only when the visitor closes the chat.
    function releaseLock() {
      locked = false
      canDismiss = true
      if (lockTimer) {
        clearTimeout(lockTimer)
        lockTimer = null
      }
      removeNotifyCard()
      hideWaitNotice()
      updateLockUI()
    }

    function exitLock() {
      if (!locked) return
      locked = false
      canDismiss = false
      if (lockTimer) {
        clearTimeout(lockTimer)
        lockTimer = null
      }
      removeNotifyCard()
      hideWaitNotice()
      exitFullscreen()
      updateLockUI()
    }

    // ----- Hold the visitor while locked, WITHOUT fighting the browser -----
    // We still hold them in the conversation: the panel is a fixed, full-window
    // overlay (see enterFullscreen) that covers the page on its own, so leaving
    // native fullscreen does NOT free them — the overlay stays. We deliberately
    // do NOT force-re-request native fullscreen on every Esc/gesture: that is a
    // dark pattern browsers actively block (each blocked request logs a console
    // error and triggers a fresh permission fight). When they exit native
    // fullscreen we simply keep the overlay; the escape hatch is the install/
    // push card, not an endless fullscreen tug-of-war.
    function onFsChange() {
      // Nothing to force. The overlay already holds the visitor; we only update
      // UI affordances here if needed in the future.
    }
    ;[
      'fullscreenchange',
      'webkitfullscreenchange',
      'mozfullscreenchange',
      'MSFullscreenChange',
    ].forEach(function (ev) {
      document.addEventListener(ev, onFsChange)
    })

    function removeNotifyCard() {
      if (notifyCardEl && notifyCardEl.parentNode) {
        notifyCardEl.parentNode.removeChild(notifyCardEl)
      }
      notifyCardEl = null
    }

    // Swap the card's inner content between its three states: offer / enabled /
    // blocked. Kept in one place so the styling stays consistent.
    function paintNotifyCard(mode) {
      if (!notifyCardEl) return
      notifyCardEl.innerHTML = ''

      var top = document.createElement('div')
      top.style.cssText = 'display:flex;align-items:center;gap:12px'

      var chip = document.createElement('div')
      chip.style.cssText =
        'width:38px;height:38px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:' +
        (mode === 'enabled' ? '#dcfce7' : tint(primary, '1f')) +
        ';color:' +
        (mode === 'enabled' ? '#16a34a' : primary)
      chip.innerHTML =
        mode === 'enabled'
          ? ICON_CHECK
          : '<span class="csw-bell-anim" style="display:flex">' +
            ICON_BELL +
            '</span>'

      var txt = document.createElement('div')
      txt.style.cssText = 'min-width:0;flex:1'
      var t = document.createElement('div')
      t.style.cssText =
        'font-weight:700;font-size:14px;color:' + FG + ';margin-bottom:2px'
      var s = document.createElement('div')
      s.style.cssText =
        'font-size:12.5px;line-height:1.45;color:' + MUTED_FG

      if (mode === 'enabled') {
        t.textContent = 'Уведомления включены'
        s.textContent =
          'Можно свернуть чат — мы пришлём оповещение, как только оператор ответит.'
      } else if (mode === 'blocked') {
        t.textContent = 'Уведомления отключены в браузере'
        s.textContent =
          'Разрешите их в настройках сайта, чтобы получить ответ, или просто подождите здесь — оператор уже подключается.'
      } else {
        t.textContent = 'Не пропустите ответ'
        s.textContent =
          'Оператор уже подключается. Включите уведомления — и мы сообщим вам, как только придёт ответ.'
      }
      txt.appendChild(t)
      txt.appendChild(s)
      top.appendChild(chip)
      top.appendChild(txt)
      notifyCardEl.appendChild(top)

      var actions = document.createElement('div')
      actions.style.cssText = 'display:flex;gap:8px;margin-top:12px'

      if (mode === 'offer') {
        var enableBtn = document.createElement('button')
        enableBtn.type = 'button'
        enableBtn.textContent = 'Включить уведомления'
        enableBtn.style.cssText =
          'flex:1;border:none;border-radius:12px;padding:11px 14px;font-size:13.5px;font-weight:600;cursor:pointer;color:#fff;background:' +
          primary +
          ';box-shadow:0 4px 12px ' +
          tint(primary, '4d') +
          ';transition:opacity .15s ease'
        enableBtn.addEventListener('mouseenter', function () {
          enableBtn.style.opacity = '.9'
        })
        enableBtn.addEventListener('mouseleave', function () {
          enableBtn.style.opacity = '1'
        })
        enableBtn.addEventListener('click', function () {
          ensureNotifications()
        })
        actions.appendChild(enableBtn)
      } else {
        // Once notifications are sorted (granted or blocked) we surface the way
        // out of the locked conversation.
        var minBtn = document.createElement('button')
        minBtn.type = 'button'
        minBtn.textContent =
          mode === 'enabled' ? 'Свернуть чат' : 'Подождать здесь'
        minBtn.style.cssText =
          'flex:1;border:1px solid ' +
          BORDER +
          ';border-radius:12px;padding:11px 14px;font-size:13.5px;font-weight:600;cursor:pointer;color:' +
          FG +
          ';background:#fff;transition:background .15s ease'
        minBtn.addEventListener('mouseenter', function () {
          minBtn.style.background = MUTED_BG
        })
        minBtn.addEventListener('mouseleave', function () {
          minBtn.style.background = '#fff'
        })
        minBtn.addEventListener('click', function () {
          if (mode === 'enabled') {
            closeChat()
          } else {
            removeNotifyCard()
          }
        })
        actions.appendChild(minBtn)
      }
      notifyCardEl.appendChild(actions)
    }

    function showNotifyCard() {
      if (!supportsNotifications()) {
        // No Notification API at all → never trap the visitor permanently.
        canDismiss = true
        updateLockUI()
        return
      }
      if (Notification.permission === 'granted') {
        notifyEnabled = true
        canDismiss = true
        updateLockUI()
      }
      if (notifyCardEl) return
      notifyCardEl = document.createElement('div')
      notifyCardEl.style.cssText =
        'flex-shrink:0;padding:16px;border-top:1px solid ' +
        BORDER +
        ';background:linear-gradient(135deg,' +
        tint(primary, '14') +
        ',' +
        tint(primary, '08') +
        ');animation:csw-fade-up .3s cubic-bezier(.21,1.02,.73,1) both'
      // Place it just above the composer so it's always visible.
      safeInsertBefore(panel, notifyCardEl, form)
      paintNotifyCard(notifyEnabled ? 'enabled' : 'offer')
    }

    // Request notification permission RIGHT ON THE VISITOR'S OWN SITE. No popup,
    // no redirect to our domain — notifications are same-origin to the host site
    // (delivered via the host service worker the customer uploaded). Safe to
    // call repeatedly; resolves the optional callback once the choice is made.
    var notifyRequested = false
    function ensureNotifications(done) {
      done = typeof done === 'function' ? done : function () {}
      if (!supportsNotifications()) {
        // No Notification API (e.g. iOS Safari tab) → don't trap the visitor.
        canDismiss = true
        updateLockUI()
        return done('unsupported')
      }
      if (Notification.permission === 'granted') {
        notifyEnabled = true
        canDismiss = true
        updateLockUI()
        if (notifyCardEl) paintNotifyCard('enabled')
        try {
          chat.subscribePush()
        } catch (e) {}
        return done('granted')
      }
      if (Notification.permission === 'denied') {
        canDismiss = true
        updateLockUI()
        if (notifyCardEl) paintNotifyCard('blocked')
        return done('denied')
      }
      if (notifyRequested) return
      notifyRequested = true
      var settled = false
      var settle = function (perm) {
        if (settled) return
        settled = true
        notifyRequested = false
        if (perm === 'granted') {
          notifyEnabled = true
          canDismiss = true
          updateLockUI()
          if (notifyCardEl) paintNotifyCard('enabled')
          try {
            chat.subscribePush()
          } catch (e) {}
        } else {
          canDismiss = true
          updateLockUI()
          if (notifyCardEl) paintNotifyCard('blocked')
        }
        done(perm)
      }
      try {
        var p = Notification.requestPermission(settle)
        if (p && typeof p.then === 'function') p.then(settle)
      } catch (e) {
        settle('denied')
      }
    }

    function fireReplyNotification(msg) {
      if (!notifyEnabled || !supportsNotifications()) return
      try {
        if (Notification.permission !== 'granted') return
        // Only notify when the visitor can't already see the reply: tab hidden
        // or the chat panel minimized.
        if (isOpen && !document.hidden) return
        var title =
          cfg.appearance.agentName || cfg.appearance.title || 'Новое сообщение'
        var opts = {
          body: msg && msg.body ? msg.body : 'Оператор ответил вам',
          icon: cfg.appearance.agentAvatar || undefined,
          tag: 'csw-reply',
        }
        // Android Chrome forbids `new Notification()` and requires the service
        // worker. Prefer the host SW registration when present; fall back to the
        // page Notification constructor for desktop browsers.
        if ('serviceWorker' in navigator && navigator.serviceWorker.ready) {
          navigator.serviceWorker.ready
            .then(function (reg) {
              if (reg && reg.showNotification) {
                reg.showNotification(title, opts)
              } else {
                showPageNotification(title, opts)
              }
            })
            .catch(function () {
              showPageNotification(title, opts)
            })
        } else {
          showPageNotification(title, opts)
        }
      } catch (e) {}
    }

    function showPageNotification(title, opts) {
      try {
        var n = new Notification(title, opts)
        n.onclick = function () {
          try {
            window.focus()
          } catch (e) {}
          openChat()
          try {
            n.close()
          } catch (e) {}
        }
      } catch (e) {}
    }

    // Emit a live "visitor is typing" ping (with draft preview) as the visitor
    // writes; a stop-timer sends a "stopped" ping ~2.5s after they pause.
    var visitorTypingStop = null
    input.addEventListener('input', function () {
      if (preview) return
      var text = input.value
      if (text.trim()) {
        chat.sendTyping(true, text)
        if (visitorTypingStop) clearTimeout(visitorTypingStop)
        visitorTypingStop = setTimeout(function () {
          chat.sendTyping(false, '')
          visitorTypingStop = null
        }, 2500)
      } else if (visitorTypingStop) {
        clearTimeout(visitorTypingStop)
        visitorTypingStop = null
        chat.sendTyping(false, '')
      }
    })

    /* ============================ INSTALL GATE ============================ *
     * Require the visitor to install the host site as an app (PWA) before they
     * can send their first message. See public/sw.js for why the host site
     * must ship one tiny same-origin service-worker file.
     * ===================================================================== */
    var deferredPrompt = null // captured beforeinstallprompt event (Chromium)
    var installGateEl = null // the install card element (null when hidden)
    var pendingGateText = null // first message held until install completes
    var swReady = false // host-site service worker registered OK
    var pwaInstalled = false // app installed (this session or remembered)

    // Returning visitors who already installed shouldn't be nagged again.
    try {
      pwaInstalled =
        localStorage.getItem('sc_app_installed') === '1' ||
        localStorage.getItem('omnidesk_pwa_installed') === '1'
    } catch (e) {}

    function isStandalone() {
      try {
        return (
          (window.matchMedia &&
            window.matchMedia('(display-mode: standalone)').matches) ||
          window.navigator.standalone === true
        )
      } catch (e) {
        return false
      }
    }

    function isIOS() {
      var ua = navigator.userAgent || ''
      var ios = /iPad|iPhone|iPod/.test(ua)
      // iPadOS 13+ masquerades as desktop Safari → detect via touch points.
      var iPadOS =
        navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1
      return ios || iPadOS
    }

    function isFirefox() {
      return /firefox|fxios/i.test(navigator.userAgent || '')
    }

    // Gate is satisfied when the app is already installed / running standalone.
    function gatePassed() {
      return pwaInstalled || isStandalone()
    }

    // Inject a Web App Manifest for the HOST site so the browser treats it as
    // installable. The manifest itself is a same-origin blob (start_url/scope on
    // the host origin); its icons are served cross-origin from our panel, which
    // browsers allow. If the host already ships its own manifest we leave it
    // alone and rely on that.
    var manifestInjected = false
    function injectManifest() {
      if (manifestInjected) return
      try {
        if (document.querySelector('link[rel="manifest"]')) {
          manifestInjected = true // host has its own — respect it
          return
        }
        var base = (DEFAULT_BASE || '').replace(/\/$/, '')
        var name = cfg.appearance.title || 'Чат поддержки'
        var manifest = {
          name: name,
          short_name: (name || 'Чат').slice(0, 12),
          start_url: location.origin + '/',
          scope: '/',
          display: 'standalone',
          background_color: '#ffffff',
          theme_color: isHex(primary) ? primary : '#2563eb',
          icons: [
            {
              src: base + '/app-icon-192.png',
              sizes: '192x192',
              type: 'image/png',
              purpose: 'any maskable',
            },
            {
              src: base + '/app-icon-512.png',
              sizes: '512x512',
              type: 'image/png',
              purpose: 'any maskable',
            },
          ],
        }
        var blob = new Blob([JSON.stringify(manifest)], {
          type: 'application/manifest+json',
        })
        var link = document.createElement('link')
        link.rel = 'manifest'
        link.setAttribute('data-csw-manifest', '')
        link.href = URL.createObjectURL(blob)
        ;(document.head || document.documentElement).appendChild(link)
        manifestInjected = true
      } catch (e) {}
    }

    // Register the host-site service worker (the file the customer uploaded to
    // their root). Required for installability; if it's missing the register
    // promise rejects and the gate falls back to its "unavailable" state.
    function registerHostSW() {
      try {
        if (!('serviceWorker' in navigator)) return
        // Best-effort: register the visitor service worker from the page root so
        // installability/push can work when the file is reachable there. If it
        // isn't, the register promise rejects and the gate falls back to its
        // "unavailable" state — the chat itself is unaffected.
        var swUrl = location.origin + '/widget-sw.js'
        navigator.serviceWorker
          .register(swUrl, { scope: '/' })
          .then(function () {
            swReady = true
            if (installGateEl) paintInstallGate()
          })
          .catch(function () {
            swReady = false
            if (installGateEl) paintInstallGate()
          })
      } catch (e) {}
    }

    function setupPwa() {
      if (preview) return
      injectManifest()
      registerHostSW()
      window.addEventListener('beforeinstallprompt', function (e) {
        // Stash the event so we can trigger the prompt from our own button.
        e.preventDefault()
        deferredPrompt = e
        if (installGateEl) paintInstallGate()
      })
      window.addEventListener('appinstalled', function () {
        pwaInstalled = true
        try {
          localStorage.setItem('sc_app_installed', '1')
        } catch (e) {}
        onGatePassed()
      })
      // If the visitor launches the installed app later, pass immediately.
      if (isStandalone()) pwaInstalled = true
    }

    // Enable/disable the composer while the gate holds the visitor.
    function setComposerEnabled(on) {
      try {
        input.disabled = !on
        sendBtn.disabled = !on
        input.style.opacity = on ? '1' : '.5'
        sendBtn.style.opacity = on ? '1' : '.5'
        input.style.pointerEvents = on ? '' : 'none'
      } catch (e) {}
    }

    function removeInstallGate() {
      if (installGateEl && installGateEl.parentNode) {
        installGateEl.parentNode.removeChild(installGateEl)
      }
      installGateEl = null
      setComposerEnabled(true)
    }

    // Called the moment the app is installed / detected as installed.
    // SINGLE FLOW: right after install we immediately turn on notifications (on
    // the visitor's OWN site), then release the held first message. Whether the
    // visitor grants or skips notifications, the message is always sent.
    function onGatePassed() {
      removeInstallGate()
      var release = function () {
        if (pendingGateText) {
          var t = pendingGateText
          pendingGateText = null
          doSend(t)
        }
      }
      ensureNotifications(release)
    }

    function triggerInstall() {
      if (!deferredPrompt) return
      var dp = deferredPrompt
      deferredPrompt = null
      try {
        dp.prompt()
        if (dp.userChoice && dp.userChoice.then) {
          dp.userChoice.then(function (choice) {
            // Accepted → 'appinstalled' fires and runs onGatePassed().
            // Dismissed → can't re-prompt this load; show manual fallback.
            if (!choice || choice.outcome !== 'accepted') paintInstallGate()
          })
        }
      } catch (e) {
        paintInstallGate()
      }
    }

    // Decide which message the gate should show right now.
    function gateMode() {
      if (deferredPrompt) return 'offer' // one-tap install available
      if (isIOS()) return 'ios' // manual "Add to Home Screen"
      if (isFirefox()) return 'unavailable' // no install prompt API
      if (swReady) return 'manual' // installable via browser menu
      return 'unavailable' // SW missing / unsupported
    }

    function paintInstallGate() {
      if (!installGateEl) return
      var mode = gateMode()
      installGateEl.innerHTML = ''

      var top = document.createElement('div')
      top.style.cssText = 'display:flex;align-items:center;gap:12px'
      var chip = document.createElement('div')
      chip.style.cssText =
        'width:38px;height:38px;border-radius:12px;flex-shrink:0;display:flex;align-items:center;justify-content:center;background:' +
        tint(primary, '1f') +
        ';color:' +
        primary
      chip.innerHTML = ICON_DOWNLOAD
      var txt = document.createElement('div')
      txt.style.cssText = 'min-width:0;flex:1'
      var t = document.createElement('div')
      t.style.cssText =
        'font-weight:700;font-size:14px;color:' + FG + ';margin-bottom:2px'
      var s = document.createElement('div')
      s.style.cssText = 'font-size:12.5px;line-height:1.45;color:' + MUTED_FG

      if (mode === 'offer' || mode === 'manual') {
        t.textContent = 'Установите приложение, чтобы написать'
        s.textContent =
          mode === 'offer'
            ? 'Один тап — установим приложение и включим уведомления, чтобы вы не пропустили ответ. Сообщение отправится автоматически.'
            : 'Откройте меню браузера и выберите «Установить приложение», затем вернитесь сюда — уведомления включим автоматически.'
      } else if (mode === 'ios') {
        t.textContent = 'Добавьте сайт на экран «Домой»'
        s.innerHTML =
          'Нажмите ' +
          ICON_IOS_SHARE +
          ' в панели браузера, затем «На экран «Домой»». Откройте приложение — мы сразу предложим включить уведомления и отправим ваше сообщение.'
      } else {
        t.textContent = 'Установка недоступна в этом браузере'
        s.textContent =
          'Чтобы написать нам, откройте сайт в Google Chrome (Android/компьютер) и установите приложение.'
      }
      txt.appendChild(t)
      txt.appendChild(s)
      top.appendChild(chip)
      top.appendChild(txt)
      installGateEl.appendChild(top)

      if (mode === 'offer') {
        var actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:8px;margin-top:12px'
        var btn = document.createElement('button')
        btn.type = 'button'
        btn.textContent = 'Установить и включить уведомления'
        btn.style.cssText =
          'flex:1;border:none;border-radius:12px;padding:11px 14px;font-size:13.5px;font-weight:600;cursor:pointer;color:#fff;background:' +
          primary +
          ';box-shadow:0 4px 12px ' +
          tint(primary, '4d') +
          ';transition:opacity .15s ease'
        btn.addEventListener('mouseenter', function () {
          btn.style.opacity = '.9'
        })
        btn.addEventListener('mouseleave', function () {
          btn.style.opacity = '1'
        })
        btn.addEventListener('click', triggerInstall)
        actions.appendChild(btn)
        installGateEl.appendChild(actions)
      }
    }

    function showInstallGate() {
      if (!isOpen) openChat()
      setComposerEnabled(false)
      if (installGateEl) {
        paintInstallGate()
        return
      }
      installGateEl = document.createElement('div')
      installGateEl.style.cssText =
        'flex-shrink:0;padding:16px;border-top:1px solid ' +
        BORDER +
        ';background:linear-gradient(135deg,' +
        tint(primary, '14') +
        ',' +
        tint(primary, '08') +
        ');animation:csw-fade-up .3s cubic-bezier(.21,1.02,.73,1) both'
      safeInsertBefore(panel, installGateEl, form)
      paintInstallGate()
    }

    // The actual send. Split out of the submit handler so the install-gate can
    // hold the first message and replay it here verbatim once the visitor has
    // installed the app.
    function doSend(text) {
      hasRealMessages = true
      if (welcomeEl && welcomeEl.parentNode) {
        welcomeEl.parentNode.removeChild(welcomeEl)
        welcomeEl = null
      }
      bubble({ direction: 'in', body: text, id: 'local-' + Date.now() })
      input.value = ''
      renderQuickReplies()
      if (preview) return
      // Sending now — clear our "typing" indicator on the agent's side.
      if (visitorTypingStop) {
        clearTimeout(visitorTypingStop)
        visitorTypingStop = null
      }
      chat.sendTyping(false, '')
      // Take over the screen and hold the visitor until an operator replies.
      enterLock()
      chat.send(text).then(function (res) {
        res = res || {}
        if (res.noAgents) {
          systemNote(
            'К сожалению, сейчас мы не можем ответить. Оставьте сообщение — мы свяжемся с вами, как только освободимся.',
          )
          // No operator to reply right now — offer notifications immediately
          // instead of making the visitor wait out the timer.
          if (locked && !notifyCardEl) showNotifyCard()
        } else if (res.ok === false) {
          systemNote('Не удалось отправить сообщение. Попробуйте ещё раз.')
        }
      })
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault()
      var text = input.value.trim()
      if (!text) return
      // INSTALL GATE: outside the admin preview, the visitor must install the
      // site as an app before the FIRST message can be sent. We hold the text,
      // surface the install card, and replay it via doSend() once installed.
      // gatePassed() is true when already running as an installed app (or a
      // previous install was recorded), so returning visitors are never nagged.
      if (!preview && !gatePassed()) {
        pendingGateText = text
        showInstallGate()
        return
      }
      doSend(text)
    })

    // Initial paint.
    applyConfig(cfg)

    // Arm the install gate early so beforeinstallprompt is captured before the
    // visitor ever tries to send (no-op in the admin preview).
    setupPwa()

    if (preview) {
      // Preview: force the panel open and never connect to the network.
      activeConfirmed = true
      launcher.style.display = 'block'
      isOpen = true
      setLauncherIcon(true)
      panel.style.display = 'flex'
      statusText.textContent = defaultStatusLine()
      statusDot.style.background = '#4ade80'
      revealWidget()
    } else {
      // Safety net: if the config request is slow or the network is down, reveal
      // anyway after a short delay so the widget never stays invisible.
      setTimeout(revealWidget, 1200)
    }

    chat.open = openChat
    chat.close = closeChat
    chat.toggle = toggle
    chat.applyConfig = applyConfig
    chat.applyOffHours = applyOffHours
    return chat
  }

  /* ----------------------------- Bootstrap --------------------------- */

  var pendingOn = []
  var instance = null

  var publicApi = {
    on: function (event, cb) {
      if (instance) return instance.on(event, cb)
      pendingOn.push([event, cb])
      return function () {}
    },
    open: function (prefill) {
      if (instance && instance.open) instance.open(prefill)
    },
    close: function () {
      if (instance && instance.close) instance.close()
    },
    get instance() {
      return instance
    },
  }

  // Single global for optionally controlling/observing the widget.
  window.SupportChat = publicApi

  // Read a data-* attribute by its neutral name, falling back to the legacy
  // brand-prefixed name so snippets already deployed on customer sites keep
  // working after this update.
  function attr(name) {
    if (!currentScript) return ''
    return (
      currentScript.getAttribute('data-support-' + name) ||
      currentScript.getAttribute('data-omnidesk-' + name) ||
      ''
    )
  }

  // Preview mode: mounted inside the admin editor iframe. No network; config
  // arrives via postMessage from the parent window.
  var isPreview = attr('preview')
  if (isPreview) {
    var bootPreview = function () {
      instance = mountWidget(clientDefaultConfig(), { preview: true })
      window.addEventListener('message', function (ev) {
        var data = ev && ev.data
        if (!data || typeof data !== 'object') return
        if (data.type === 'omnidesk:config' && data.config) {
          instance.applyConfig(data.config)
        } else if (data.type === 'omnidesk:offhours') {
          instance.applyOffHours({ offHours: !!data.offHours })
        }
      })
      // Tell the parent we're ready to receive config.
      try {
        ;(window.parent || window).postMessage({ type: 'omnidesk:ready' }, '*')
      } catch (e) {}
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootPreview)
    } else {
      bootPreview()
    }
  }

  // Auto-mount when the script tag carries data-support-key (or an older
  // equivalent attribute name). The key is the only attribute needed —
  // everything visual is fetched live from the server config.
  var autoKey = attr('key')
  if (autoKey && !isPreview) {
    var boot = function () {
      var boot0 = bootConfigFrom({})
      // Stash the key/subject so mountWidget's create() can use them.
      boot0.__key = autoKey
      boot0.__subject = attr('subject')
      instance = mountWidget(boot0, { preview: false })
      pendingOn.forEach(function (pair) {
        instance.on(pair[0], pair[1])
      })
      pendingOn = []
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot)
    } else {
      boot()
    }
  }
})()
