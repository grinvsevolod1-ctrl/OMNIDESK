import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
import { UpdateWatcher } from '@/components/update-watcher'
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
  // Keep the iOS keyboard from zooming/shoving the layout: lock scale so a tap
  // on the composer input never triggers Safari's auto-zoom (inputs are ≥16px).
  maximumScale: 1,
  userScalable: false,
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
        <ErrorReporter />
      </body>
    </html>
  )
}
