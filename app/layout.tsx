import type { Metadata, Viewport } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Toaster } from '@/components/ui/sonner'
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
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="ru"
      className={`dark ${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="bg-background text-foreground font-sans antialiased">
        {children}
        <Toaster />
      </body>
    </html>
  )
}
