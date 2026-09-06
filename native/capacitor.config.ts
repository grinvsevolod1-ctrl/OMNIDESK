import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor shell for the OMNIDESK panel.
 *
 * This is a REMOTE-URL app: OMNIDESK is a server-rendered Next.js app (server
 * actions, middleware, Postgres) and cannot be statically exported into the
 * bundle, so the native shell simply loads the live HTTPS site inside a
 * WKWebView (iOS) / WebView (Android). The WebView loads our origin first-party,
 * so the session cookie and all server actions work exactly as in a browser.
 *
 * Native push (APNs/FCM) is what the shell adds over the PWA: Apple does not
 * deliver Web Push inside a WKWebView, so the app registers for OS push and the
 * panel's dispatcher delivers via lib/native-push.ts.
 *
 * Configure per environment WITHOUT editing this file:
 *   CAP_SERVER_URL — the production panel URL the shell loads (REQUIRED)
 *   CAP_APP_ID     — reverse-DNS bundle id (must match APNS_BUNDLE_ID on the server)
 *   CAP_APP_NAME   — home-screen app name
 */

const serverUrl = process.env.CAP_SERVER_URL?.trim()

const config: CapacitorConfig = {
  appId: process.env.CAP_APP_ID?.trim() || 'app.omnidesk.mobile',
  appName: process.env.CAP_APP_NAME?.trim() || 'Omnidesk',
  // Required by the CLI even for remote-URL apps; www/ holds only the offline
  // fallback shown when the panel is unreachable.
  webDir: 'www',
  server: serverUrl
    ? {
        url: serverUrl,
        // Never allow plaintext — the panel is HTTPS-only (auth cookies).
        cleartext: false,
        androidScheme: 'https',
      }
    : undefined,
  ios: {
    // Let the web app own the safe-area insets (it already handles them via
    // env(safe-area-inset-*)), so the WebView content sits under the notch.
    contentInset: 'never',
  },
  plugins: {
    PushNotifications: {
      // Show banners/sound/badge even while the app is foregrounded.
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
}

export default config
