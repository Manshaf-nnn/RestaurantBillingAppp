import Image from 'next/image'
import Link from 'next/link'

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="theme-light relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-[#f5f6fa] px-4 py-10 text-foreground">
      {/* Soft warm brand glow + a subtle dotted texture for a classic SaaS feel. */}
      <div className="pointer-events-none absolute -left-40 -top-24 size-[520px] rounded-full bg-primary/10 blur-3xl" />
      <div className="pointer-events-none absolute -bottom-32 -right-40 size-[520px] rounded-full bg-chart-5/10 blur-3xl" />
      <div
        className="pointer-events-none absolute right-8 top-16 hidden size-44 opacity-[0.18] xl:block"
        style={{
          backgroundImage: 'radial-gradient(#f97316 1.6px, transparent 1.6px)',
          backgroundSize: '18px 18px',
        }}
      />
      <div
        className="pointer-events-none absolute bottom-16 left-8 hidden size-44 opacity-[0.15] xl:block"
        style={{
          backgroundImage: 'radial-gradient(#1e3a5f 1.6px, transparent 1.6px)',
          backgroundSize: '18px 18px',
        }}
      />

      <div className="relative z-10 w-full max-w-[440px] animate-fade-up">
        <div className="rounded-[28px] border border-black/[0.06] bg-white p-8 shadow-elevated sm:p-10">
          <div className="mb-8 flex justify-center">
            <Link href="/">
              <Image
                src="/logo-full.png"
                alt="TableFlow — Smart Dining, Simplified"
                width={1143}
                height={380}
                priority
                className="h-12 w-auto"
              />
            </Link>
          </div>

          {children}
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} TableFlow · Smart Dining, Simplified
        </p>
      </div>
    </div>
  )
}
