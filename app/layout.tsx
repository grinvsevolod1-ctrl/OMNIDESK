import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import { UpdateWatcher } from '@/components/update-watcher'
import { PwaReinstallNotice } from '@/components/pwa-reinstall-notice'
import { PwaInstallPrompt } from '@/components/pwa-install-prompt'
import { ErrorReporter } from '@/components/error-reporter'
import { RUNTIME_BUILD_ID } from '@/lib/build-id'
import './globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
})

export const metadata: Metadata = {
  title: 'Omnidesk — единый центр входящих',
  description:
    'Self-hosted панель для подключения Telegram, WhatsApp и онлайн-чатов сайтов. Рабочие пространства администратора и менеджера.',
  // This is a private self-hosted ops panel — nothing here should ever be
  // indexed by search engines. Applying noindex/nofollow site-wide keeps every
  // route (including the god-mode console) out of search results without naming
  // any path (unlike a robots.txt Disallow, which would leak the secret route).
  robots: { index: false, follow: false, nocache: true },
  manifest: '/manifest.webmanifest',
  icons: {
    icon: [
      { url: '/icon-light-32x32.png', sizes: '32x32', type: 'image/png' },
      { url: '/app-icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/app-icon-192.png', sizes: '192x192', type: 'image/png' }],
  },
  appleWebApp: {
    capable: true,
    title: 'Omnidesk',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  width: 'device-width',
  initialScale: 1,
  // Fill the whole iPhone screen edge-to-edge (behind the notch / Dynamic
  // Island / home indicator) and expose the safe-area env() insets that the
  // chat shell and composer pad against. Without this iOS letterboxes the PWA.
  viewportFit: 'cover',
  // Pinch-zoom stays ENABLED (WCAG 1.4.4 — low-vision users rely on it, and
  // iOS ignores user-scalable=no anyway). Safari's focus auto-zoom — the reason
  // this used to be locked — is prevented at the source: every input/textarea
  // renders at ≥16px on mobile (`text-base md:text-sm` in components/ui), so
  // the browser never needs to zoom to make a focused field legible.
  maximumScale: 5,
  userScalable: true,
  // Android Chrome: when the on-screen keyboard opens, resize the LAYOUT
  // viewport (not just the visual one) so the `fixed inset-0` app shell and
  // `100dvh` shrink to the space above the keyboard. Without this the default
  // `resizes-visual` lets the keyboard OVERLAY the page and the browser scrolls
  // the fixed shell up — the reported "экран швыряет вверх, всё чёрное" bug when
  // tapping the composer. (iOS ignores this key; its keyboard is handled by the
  // visualViewport --app-vh override in dashboard-shell.)
  interactiveWidget: 'resizes-content',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="ru"
      data-scroll-behavior="smooth"
      className={`dark ${geistSans.variable} ${geistMono.variable}`}
    >
      <head>
        {/* iOS standalone trigger. Next 16's `appleWebApp.capable` only emits
            the modern `mobile-web-app-capable`, which iOS Safari IGNORES — so a
            home-screen icon opened in Safari-chrome (visible site title +
            back/refresh/share toolbar) instead of a real app window, and iOS
            Web Push (standalone-only) never became available. The Apple-prefixed
            tag is what actually puts the launched icon into standalone mode;
            with it, `apple-mobile-web-app-status-bar-style` and the safe-area
            insets the shell already pads against finally take effect.
            Must be re-added on every deploy — remove it and iOS regresses to a
            browser tab. */}
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {/* Build id baked into THIS server-rendered HTML shell. A PWA (esp. an
            installed iOS standalone window) can cold-open a stale shell that the
            OS/webview cached from an older deploy; UpdateWatcher reads this on
            mount and, if it no longer matches the live build, reloads once so
            every user always lands on the current version. */}
        <meta name="x-app-build" content={RUNTIME_BUILD_ID} />
      </head>
      <body className="bg-background text-foreground font-sans antialiased">
        {children}
        <Toaster />
        <UpdateWatcher />
        <PwaReinstallNotice />
        <PwaInstallPrompt />
        <ErrorReporter />
      </body>
    </html>
  )
}
