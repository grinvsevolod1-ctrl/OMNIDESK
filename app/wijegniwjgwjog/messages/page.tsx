import type { Metadata, Viewport } from 'next'
import { isMessengerUnlocked } from '@/lib/messenger-gate'
import { listAllChannels, listManagers } from '@/lib/data'
import { isPushConfigured } from '@/lib/push'
import { MessengerGate } from '@/components/admin/god-messenger/messenger-gate'
import { GodMessenger } from '@/components/admin/god-messenger/god-messenger'

export const dynamic = 'force-dynamic'

// Its own installable PWA identity, separate from the main Omnidesk manifest —
// so the god messenger installs as a standalone "Messages" app on the phone.
export const metadata: Metadata = {
  title: 'Messages',
  manifest: '/messenger.webmanifest',
  // iOS "Add to Home Screen" uses the apple-touch-icon from the page head, NOT
  // the manifest. Without this it would inherit the root Omnidesk icon, so we
  // pin the messenger's own icon here to make it a distinct standalone app.
  icons: {
    icon: [
      { url: '/messenger-icon-192.png', sizes: '192x192', type: 'image/png' },
      { url: '/messenger-icon-512.png', sizes: '512x512', type: 'image/png' },
    ],
    apple: [
      { url: '/messenger-icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
  },
  appleWebApp: {
    capable: true,
    title: 'Messages',
    statusBarStyle: 'black-translucent',
  },
}

export const viewport: Viewport = {
  themeColor: '#0a0a0a',
  userScalable: false,
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
}

/**
 * God messenger — a phone-friendly, full-screen surface for chatting AS THE
 * CLIENT with your own managers. Protected by its OWN standalone passcode
 * (`MessengerGate`) — no admin login or god-panel unlock required, so it opens
 * on a phone with just the messenger password. It reuses the god-console server
 * actions, so every message written here flows through the real
 * conversations/messages tables and lands live in the target manager's inbox.
 */
export default async function GodMessagesPage() {
  if (!(await isMessengerUnlocked())) return <MessengerGate />

  const [channels, managers] = await Promise.all([
    listAllChannels(),
    listManagers(),
  ])

  return (
    <GodMessenger
      channels={channels}
      managers={managers}
      pushAvailable={isPushConfigured()}
    />
  )
}
