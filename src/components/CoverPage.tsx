"use client"

import React, { useEffect, useRef, useState } from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import {
  ArrowRight,
  Clock,
  CreditCard,
  QrCode,
  Search,
  UtensilsCrossed,
  MapPin,
  Utensils,
} from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { resolveTable } from '@/features/orders/actions'
import { useCart } from '@/features/orders/cart-store'

interface Props {
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  city: string | null
  isOpen: boolean
  openingLabel: string | null
}

function rgbToCss(r: number, g: number, b: number) {
  return `${r}, ${g}, ${b}`
}

async function extractThemeColor(url: string | null) {
  if (!url) return { r: 249, g: 115, b: 22 } // Warm Amber/Orange default
  try {
    const img = new window.Image()
    img.crossOrigin = 'anonymous'
    img.src = url

    await new Promise((res, rej) => {
      img.onload = res
      img.onerror = rej
    })

    const size = 40
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    if (!ctx) return { r: 249, g: 115, b: 22 }
    ctx.drawImage(img, 0, 0, size, size)
    const data = ctx.getImageData(0, 0, size, size).data

    let r = 0
    let g = 0
    let b = 0
    let count = 0

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha < 100) continue
      const rr = data[i]
      const gg = data[i + 1]
      const bb = data[i + 2]
      const max = Math.max(rr, gg, bb)
      const min = Math.min(rr, gg, bb)
      const sat = max === 0 ? 0 : (max - min) / max
      const weight = 1 + sat * 2
      r += rr * weight
      g += gg * weight
      b += bb * weight
      count += weight
    }

    if (!count) return { r: 249, g: 115, b: 22 }
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
  } catch {
    return { r: 249, g: 115, b: 22 }
  }
}

export default function CoverPage(props: Props) {
  const { restaurantName, tagline, logoUrl, coverUrl, city, isOpen, openingLabel } = props
  const [theme, setTheme] = useState({ r: 249, g: 115, b: 22 })
  const [tableNumber, setTableNumber] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)

  const router = useRouter()
  const { setTable } = useCart()

  const bgImage = coverUrl || '/default-cover.jpg'

  useEffect(() => {
    let mounted = true
    if (!bgImage) return
    extractThemeColor(bgImage).then((c) => {
      if (mounted) setTheme(c)
    })
    return () => {
      mounted = false
    }
  }, [bgImage])

  const rgb = rgbToCss(theme.r, theme.g, theme.b)

  const submit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault()
    setError(null)
    const trimmed = tableNumber.trim()
    if (!trimmed) {
      setError('Enter the number printed on your table')
      return
    }
    try {
      setPending(true)
      const result = await resolveTable({ tableNumber: trimmed })
      if (!result.ok) {
        setError(result.error)
        setPending(false)
        return
      }
      setTable(result.data)
      toast.success(`Table ${result.data.tableNumber} — welcome!`)
      router.push('/order/menu')
    } catch (err) {
      setError('Something went wrong')
    } finally {
      setPending(false)
    }
  }

  return (
    <div
      className="relative flex min-h-dvh w-full flex-col items-center justify-between overflow-hidden px-4 py-8 text-center selection:bg-orange-500/30 selection:text-white"
      style={{ ['--theme-r' as any]: theme.r, ['--theme-g' as any]: theme.g, ['--theme-b' as any]: theme.b }}
    >
      {/* Full-screen cover photo background */}
      <div
        className="absolute inset-0 -z-30 bg-cover bg-center scale-105 pointer-events-none"
        style={{ backgroundImage: `url(${bgImage})` }}
      />

      {/* Dark ambient overlay with smooth vignette */}
      <div
        className="absolute inset-0 -z-20 pointer-events-none"
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,0.4) 0%, rgba(5,6,10,0.65) 45%, rgba(3,4,8,0.92) 100%)`,
        }}
      />

      {/* Heavy Backdrop Blur Layer */}
      <div className="absolute inset-0 -z-10 backdrop-blur-[12px] pointer-events-none" />

      {/* Ambient glowing radial flare behind card */}
      <div
        className="absolute inset-0 -z-10 pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 55%, rgba(${rgb}, 0.25), transparent 55%)`,
        }}
      />

      {/* ── 1. SHOP HEADER SECTION ────────────────────────────────────────────── */}
      <header className="relative z-10 flex flex-col items-center w-full max-w-md pt-2 pb-4">
        {/* Shop Logo Container */}
        <div className="relative group">
          <div
            className="absolute -inset-1 rounded-2xl blur-md opacity-50 group-hover:opacity-80 transition-opacity"
            style={{ backgroundColor: `rgb(${rgb})` }}
          />
          <div className="relative flex h-22 w-22 items-center justify-center overflow-hidden rounded-2xl border border-white/40 bg-white shadow-2xl shadow-black/90 p-1 transition-transform duration-300 hover:scale-105">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={restaurantName} className="h-full w-full rounded-xl object-cover" />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white p-2">
                <Utensils className="h-8 w-8 text-white drop-shadow" />
              </div>
            )}
          </div>
        </div>

        {/* Shop Name */}
        <h1 className="mt-3.5 text-3xl font-extrabold tracking-tight text-white drop-shadow-lg">
          {restaurantName}
        </h1>

        {tagline ? (
          <p className="mt-1 text-xs font-medium text-zinc-300 drop-shadow">{tagline}</p>
        ) : null}

        {/* Hours & Status Pill Badge */}
        <div className="mt-3.5 inline-flex items-center gap-2.5 rounded-full border border-white/20 bg-black/40 backdrop-blur-xl px-4 py-1.5 text-xs font-medium text-white shadow-xl shadow-black/40">
          <Clock size={14} className="text-zinc-300" />
          <span className="text-zinc-200">{openingLabel ?? '11:00 – 23:30'}</span>
          <span className="text-white/30">•</span>
          <span className={isOpen ? 'inline-flex items-center gap-1.5 text-emerald-400 font-semibold' : 'inline-flex items-center gap-1.5 text-red-400 font-semibold'}>
            <span className={isOpen ? 'h-2 w-2 rounded-full bg-emerald-400 animate-pulse' : 'h-2 w-2 rounded-full bg-red-500'} />
            {isOpen ? 'Open' : 'Closed'}
          </span>
        </div>
      </header>

      {/* ── 2. LIQUID GLASS UI CARD ───────────────────────────────────────────── */}
      <main className="relative z-10 w-full max-w-md my-auto">
        <div
          className="relative overflow-hidden rounded-[32px] border border-amber-500/35 bg-gradient-to-b from-white/[0.15] via-white/[0.05] to-black/65 backdrop-blur-2xl p-6 shadow-[0_25px_60px_rgba(0,0,0,0.8),0_0_50px_rgba(249,115,22,0.18)] transition-all"
        >
          {/* Top-Right Corner Golden Light Refraction */}
          <div className="pointer-events-none absolute -top-12 -right-12 h-36 w-36 rounded-full bg-gradient-to-bl from-amber-400/40 via-orange-500/20 to-transparent blur-md" />

          {/* Internal Ambient Light Blobs */}
          <div
            className="pointer-events-none absolute -left-20 -top-20 h-56 w-56 rounded-full blur-3xl opacity-70"
            style={{ backgroundColor: `rgba(${rgb}, 0.22)` }}
          />
          <div
            className="pointer-events-none absolute -right-20 -bottom-20 h-56 w-56 rounded-full blur-3xl opacity-60"
            style={{ backgroundColor: `rgba(${rgb}, 0.2)` }}
          />

          <div className="relative">
            {/* TableFlow Brand Box Header */}
            <div className="flex flex-col items-center text-center">
              <p className="text-[11px] font-medium tracking-wide text-zinc-300 uppercase">
                Powered by
              </p>

              {/* TableFlow Script Logo */}
              <div className="mt-1 flex items-center justify-center">
                <span className="text-2xl font-extrabold tracking-tight text-white">Table</span>
                <span className="relative text-3xl font-extrabold italic text-transparent bg-clip-text bg-gradient-to-r from-orange-400 via-amber-400 to-orange-500 font-serif ml-0.5 pr-1">
                  Flow
                  {/* Swoosh Underline */}
                  <svg
                    className="absolute -bottom-1 left-0 w-full h-2 text-orange-500"
                    viewBox="0 0 60 12"
                    fill="none"
                    xmlns="http://www.w3.org/2000/svg"
                  >
                    <path
                      d="M2 8C18 2 42 2 58 8"
                      stroke="url(#swoosh-grad-2)"
                      strokeWidth="3"
                      strokeLinecap="round"
                    />
                    <defs>
                      <linearGradient id="swoosh-grad-2" x1="0" y1="0" x2="60" y2="0" gradientUnits="userSpaceOnUse">
                        <stop stopColor="#F97316" />
                        <stop offset="1" stopColor="#F59E0B" />
                      </linearGradient>
                    </defs>
                  </svg>
                </span>
              </div>

              <p className="mt-2 text-[10px] font-bold tracking-[0.28em] text-zinc-300 uppercase">
                SMART DINING, SIMPLIFIED.
              </p>
            </div>

            {/* Table Number Prompt */}
            <div className="mt-6 text-center">
              <h2 className="text-lg font-bold text-white tracking-tight">
                What is your table number?
              </h2>
              <p className="mt-1 text-xs text-zinc-300 font-normal">
                You will find it on the stand or card on your table.
              </p>
            </div>

            {/* Form & Table Input */}
            <form onSubmit={submit} className="mt-5">
              <div
                className={`relative flex h-16 items-center rounded-2xl border bg-black/60 backdrop-blur-md px-4 transition-all duration-300 ${
                  focused
                    ? 'border-amber-500/80 ring-4 ring-amber-500/20 shadow-[0_0_30px_rgba(249,115,22,0.3)]'
                    : tableNumber.length > 0
                    ? 'border-amber-500/60 shadow-[0_0_20px_rgba(249,115,22,0.2)]'
                    : 'border-white/20 hover:border-white/30'
                }`}
              >
                {/* Custom Table Stand Icon */}
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-white/5 text-amber-400 border border-white/10">
                  <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 7h18" />
                    <path d="M5 7v13" />
                    <path d="M19 7v13" />
                    <path d="M8 12h8" />
                    <path d="M12 7v5" />
                  </svg>
                </div>

                {/* Divider Line */}
                <div className="mx-3.5 h-7 w-[1px] bg-white/20" />

                {/* Input Field */}
                <input
                  ref={inputRef}
                  value={tableNumber}
                  onChange={(e) => {
                    setTableNumber(e.target.value.toUpperCase().slice(0, 10))
                    setError(null)
                  }}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  inputMode="numeric"
                  placeholder="5"
                  aria-label="Table number"
                  aria-describedby={error ? 'table-error' : undefined}
                  className="w-full bg-transparent text-center text-3xl font-extrabold tracking-wider text-white outline-none placeholder:text-zinc-600"
                />
              </div>

              {error ? (
                <div className="mt-3">
                  <Alert variant="destructive" className="text-center bg-red-950/80 border-red-500/50 text-red-200 py-2 text-xs">
                    {error}
                  </Alert>
                </div>
              ) : null}

              {/* Action Button */}
              <button
                type="submit"
                disabled={pending}
                className="group relative mt-4 flex h-14 w-full items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-to-r from-orange-500 via-amber-500 to-orange-600 text-base font-bold text-white shadow-lg shadow-orange-500/35 transition-all duration-300 hover:shadow-orange-500/55 hover:scale-[1.01] active:scale-[0.98] cursor-pointer disabled:opacity-50"
              >
                <span>{pending ? 'Verifying Table…' : 'Continue to the menu'}</span>
                <ArrowRight className="h-5 w-5 transition-transform duration-300 group-hover:translate-x-1" />
              </button>
            </form>

            {/* 4 Feature Pill Grid */}
            <div className="mt-6 grid grid-cols-4 gap-2.5">
              <FeatureTile icon={<QrCode size={18} />} label="Scan" />
              <FeatureTile icon={<UtensilsCrossed size={18} />} label="Order" />
              <FeatureTile icon={<Search size={18} />} label="Track" />
              <FeatureTile icon={<CreditCard size={18} />} label="Pay" />
            </div>

            {/* Footnote */}
            <p className="mt-5 text-center text-[11px] text-zinc-400 font-normal">
              No app, no sign-up. Order straight from your phone.
            </p>
          </div>
        </div>
      </main>

      {/* ── 3. FOOTER ────────────────────────────────────────────────────────── */}
      <footer className="relative z-10 py-2">
        <p className="text-[10px] text-zinc-400 font-medium">
          © {new Date().getFullYear()} {restaurantName} • Powered by TableFlow
        </p>
      </footer>
    </div>
  )
}

function FeatureTile({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1.5 rounded-2xl border border-white/10 bg-black/40 backdrop-blur-md py-3 px-1 text-center transition-all duration-200 hover:border-amber-500/30 hover:bg-black/60 hover:scale-[1.04]">
      <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/10 text-orange-400 border border-orange-500/20 shadow-inner">
        {icon}
      </div>
      <span className="text-[11px] font-medium text-zinc-300">{label}</span>
    </div>
  )
}
