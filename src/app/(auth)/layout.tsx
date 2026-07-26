import Image from 'next/image'
import Link from 'next/link'
import { QrCode, Radio, ShieldCheck } from 'lucide-react'

import { ThemeToggle } from '@/components/theme-toggle'

const HIGHLIGHTS = [
  { icon: QrCode, text: 'One QR code for every table in the room' },
  { icon: Radio, text: 'Orders reach the kitchen the instant they are placed' },
  { icon: ShieldCheck, text: 'Each restaurant’s data is fully isolated' },
]

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh lg:grid-cols-2">
      {/* Brand panel — desktop only, keeps the mobile form above the fold. */}
      <aside className="relative hidden overflow-hidden bg-gradient-to-br from-primary via-primary to-chart-5 p-12 text-primary-foreground lg:flex lg:flex-col lg:justify-between">
        <div className="pointer-events-none absolute -right-24 -top-24 size-[420px] rounded-full bg-white/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 size-[380px] rounded-full bg-black/10 blur-3xl" />

        <Link href="/" className="relative z-10 flex items-center gap-2.5">
          <span className="flex size-9 items-center justify-center rounded-xl bg-white p-1 shadow-soft">
            <Image src="/logo-mark.png" alt="" width={512} height={512} className="size-full object-contain" />
          </span>
          <span className="text-[15px] font-bold tracking-tight">TableFlow</span>
        </Link>

        <div className="relative z-10 max-w-md">
          <h2 className="text-balance text-4xl font-bold leading-tight tracking-tight">
            Everything your floor needs, on one screen.
          </h2>
          <ul className="mt-8 space-y-4">
            {HIGHLIGHTS.map((item) => (
              <li key={item.text} className="flex items-start gap-3">
                <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/15 backdrop-blur">
                  <item.icon className="size-4" />
                </span>
                <span className="text-sm leading-relaxed text-primary-foreground/90">{item.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <p className="relative z-10 text-xs text-primary-foreground/70">
          © {new Date().getFullYear()} TableFlow · Built for restaurants that move fast
        </p>
      </aside>

      <main
        id="main"
        className="relative flex flex-col justify-center overflow-hidden bg-gradient-to-b from-background to-muted/40 px-5 py-10"
      >
        {/* Soft brand glow for a little depth behind the card. */}
        <div className="pointer-events-none absolute -right-24 -top-24 size-[360px] rounded-full bg-primary/10 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 left-0 size-[320px] rounded-full bg-chart-5/10 blur-3xl" />

        <div className="absolute right-5 top-5 z-10">
          <ThemeToggle />
        </div>

        <div className="relative z-10 mx-auto w-full max-w-[440px] animate-fade-up">
          {/* Logo sits on a white card so the navy wordmark stays crisp in
              both light and dark themes. */}
          <div className="mb-6 flex justify-center">
            <Link
              href="/"
              className="inline-block rounded-2xl bg-white px-7 py-5 shadow-elevated ring-1 ring-black/5"
            >
              <Image
                src="/logo-full.png"
                alt="TableFlow — Smart Dining, Simplified"
                width={1143}
                height={380}
                priority
                className="h-10 w-auto sm:h-11"
              />
            </Link>
          </div>

          {/* The sign-in / register form in a clean surface card. */}
          <div className="rounded-3xl border bg-card/80 p-6 shadow-elevated backdrop-blur sm:p-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  )
}
