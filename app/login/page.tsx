import type { Metadata } from 'next'
import { BrandMark } from '@/components/brand'
import { LoginForm } from '@/components/login-form'

export const metadata: Metadata = {
  title: 'Вход — Omnidesk',
}

export default function LoginPage() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center px-4 py-10">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_50%_at_50%_-10%,oklch(0.2_0_0),transparent)]"
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="flex size-11 items-center justify-center rounded-xl border border-border bg-card">
            <BrandMark className="size-5 text-foreground" />
          </div>
          <div className="space-y-1">
            <h1 className="text-xl font-semibold tracking-tight">
              Вход в Omnidesk
            </h1>
            <p className="text-sm text-muted-foreground">
              Единый центр входящих для вашей команды
            </p>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-6 shadow-sm">
          <LoginForm />
        </div>
      </div>
    </main>
  )
}
