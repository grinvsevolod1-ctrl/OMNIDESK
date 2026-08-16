import type { Metadata } from 'next'
import { BrandMark } from '@/components/brand'
import { LoginForm } from '@/components/login-form'

export const metadata: Metadata = {
  title: 'Вход — Omnidesk',
}

// The proxy (middleware) emits a per-request CSP nonce with an enforcing
// 'strict-dynamic' policy. A statically prerendered page can't receive that
// per-request nonce, so under 'strict-dynamic' the browser blocks every one of
// its script tags (the script-src-elem violations previously seen only on
// /login). Rendering this route dynamically lets Next apply the live nonce to
// its scripts, so the policy passes.
export const dynamic = 'force-dynamic'

export default function LoginPage() {
  return (
    <main className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden px-4 py-10">
      {/* Ambient monochrome depth — a soft glow from above and a diffuse halo
          behind the card. Purely decorative, nothing loud. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70%_55%_at_50%_-15%,oklch(0.28_0_0),transparent_70%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-40 left-1/2 size-[38rem] -translate-x-1/2 rounded-full bg-[radial-gradient(closest-side,oklch(0.32_0_0/0.5),transparent)] blur-3xl"
      />

      <div className="relative w-full max-w-md">
        {/* Brand — каскадное появление, как открытие окна в macOS. */}
        <div className="mb-10 flex flex-col items-center gap-5 text-center">
          <div className="od-rise od-rise-1 od-glass relative flex size-16 items-center justify-center rounded-3xl">
            <BrandMark className="size-7 text-foreground" />
          </div>
          <div className="space-y-2">
            <h1 className="od-rise od-rise-2 od-hero-title text-4xl font-semibold tracking-tighter text-balance sm:text-5xl">
              Вход в Omnidesk
            </h1>
            <p className="od-rise od-rise-3 text-base text-muted-foreground text-pretty">
              Единый центр входящих для вашей команды
            </p>
          </div>
        </div>

        {/* Card */}
        <div className="od-rise od-rise-4 od-command-glow rounded-3xl border border-border bg-card/80 p-7 shadow-2xl shadow-black/40 backdrop-blur-xl sm:p-8">
          <LoginForm />
        </div>

        <p className="od-rise od-rise-4 mt-8 text-center text-xs text-muted-foreground">
          Защищённый вход · только для сотрудников
        </p>
      </div>
    </main>
  )
}
