/**
 * Client-side bridge between the web app and the Capacitor native shell for
 * native push (APNs on iOS, FCM on Android).
 *
 * Design choice: this talks to the Capacitor runtime through the globals the
 * native shell injects (`window.Capacitor`), NOT via an npm import of
 * @capacitor/push-notifications. That keeps native-only packages entirely out
 * of the Next.js web bundle — the same code is served to browsers (where it
 * detects no native runtime and no-ops) and to the WKWebView/WebView (where the
 * shell has registered the PushNotifications plugin). The remote-URL shell loads
 * our origin first-party, so the session cookie rides along on the register/
 * unregister fetches exactly like any other authenticated request.
 */

interface PermissionStatus {
  receive: 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied'
}

interface PushToken {
  value: string
}

interface PushAction {
  notification?: { data?: Record<string, unknown> }
}

/** The slice of the Capacitor PushNotifications plugin we use. */
interface PushPlugin {
  checkPermissions(): Promise<PermissionStatus>
  requestPermissions(): Promise<PermissionStatus>
  register(): Promise<void>
  addListener(
    event: 'registration',
    cb: (token: PushToken) => void,
  ): Promise<unknown>
  addListener(event: 'registrationError', cb: (err: unknown) => void): Promise<unknown>
  addListener(
    event: 'pushNotificationActionPerformed',
    cb: (action: PushAction) => void,
  ): Promise<unknown>
  removeAllListeners(): Promise<void>
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
  Plugins?: { PushNotifications?: PushPlugin }
}

function getCapacitor(): CapacitorGlobal | null {
  if (typeof window === 'undefined') return null
  const cap = (window as unknown as { Capacitor?: CapacitorGlobal }).Capacitor
  return cap ?? null
}

/** True only inside the Capacitor native shell (never in a plain browser). */
export function isNativePlatform(): boolean {
  const cap = getCapacitor()
  return Boolean(cap?.isNativePlatform?.())
}

function currentPlatform(): 'ios' | 'android' | null {
  const p = getCapacitor()?.getPlatform?.()
  return p === 'ios' || p === 'android' ? p : null
}

function getPlugin(): PushPlugin | null {
  return getCapacitor()?.Plugins?.PushNotifications ?? null
}

// The token this device last registered, kept so logout can unregister exactly
// it (and only it) on the server.
let lastToken: string | null = null

async function sendToServer(
  path: string,
  body: Record<string, unknown>,
): Promise<void> {
  try {
    await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    })
  } catch {
    /* best-effort — a failed register/unregister must never crash the app */
  }
}

let initialized = false

/**
 * Initialise native push once per app launch: wire listeners, ask for
 * permission, and register with APNs/FCM. The OS hands us a device token via the
 * 'registration' event, which we persist server-side against the signed-in
 * operator. Safe to call on every mount — it no-ops outside the native shell
 * and guards against double-registration.
 */
export async function initNativePush(): Promise<void> {
  if (initialized) return
  if (!isNativePlatform()) return
  const plugin = getPlugin()
  const platform = currentPlatform()
  if (!plugin || !platform) return
  initialized = true

  const appVersion =
    (window as unknown as { __APP_VERSION__?: string }).__APP_VERSION__ ?? null

  await plugin.addListener('registration', (token: PushToken) => {
    lastToken = token.value
    void sendToServer('/api/native-push/register', {
      platform,
      token: token.value,
      appVersion,
    })
  })

  await plugin.addListener('registrationError', () => {
    /* surfaced by the OS; nothing actionable client-side */
  })

  await plugin.addListener(
    'pushNotificationActionPerformed',
    (action: PushAction) => {
      // Deep-link: open the conversation/inbox the push points at when the user
      // taps the notification. Same-origin path, so a plain assignment keeps the
      // WebView on our app.
      const url = action.notification?.data?.url
      if (typeof url === 'string' && url.startsWith('/')) {
        window.location.assign(url)
      }
    },
  )

  const perm = await plugin.checkPermissions()
  const status =
    perm.receive === 'granted'
      ? perm
      : await plugin.requestPermissions().catch(() => null)
  if (status?.receive === 'granted') {
    await plugin.register().catch(() => {})
  }
}

/**
 * Tear down native push for THIS device on logout: drop the server row so the
 * dispatcher stops delivering here, then clear listeners. Best-effort; never
 * blocks logout. The native mirror of unsubscribePushThisDevice().
 */
export async function unregisterNativePush(): Promise<void> {
  if (!isNativePlatform()) return
  if (lastToken) {
    await sendToServer('/api/native-push/unregister', { token: lastToken })
    lastToken = null
  }
  const plugin = getPlugin()
  if (plugin) await plugin.removeAllListeners().catch(() => {})
  initialized = false
}
