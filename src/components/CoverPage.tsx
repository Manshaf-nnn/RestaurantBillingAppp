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
  Utensils,
  MapPin,
} from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
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
  if (!url) return { r: 255, g: 120, b: 40 }
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
    if (!ctx) return { r: 255, g: 120, b: 40 }
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

    if (!count) return { r: 255, g: 120, b: 40 }
    return { r: Math.round(r / count), g: Math.round(g / count), b: Math.round(b / count) }
  } catch {
    return { r: 255, g: 120, b: 40 }
  }
}

export default function CoverPage(props: Props) {
  const { restaurantName, tagline, logoUrl, coverUrl, city, isOpen, openingLabel } = props
  const [theme, setTheme] = useState({ r: 255, g: 120, b: 40 })
  const [tableNumber, setTableNumber] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const [focused, setFocused] = useState(false)

  const router = useRouter()
  const { setTable } = useCart()

  useEffect(() => {
    let mounted = true
    if (!coverUrl) return
    extractThemeColor(coverUrl).then((c) => {
      if (mounted) setTheme(c)
    })
    return () => {
      mounted = false
    }
  }, [coverUrl])

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
    <main
      className="relative text-center"
      style={{ ['--theme-r' as any]: theme.r, ['--theme-g' as any]: theme.g, ['--theme-b' as any]: theme.b }}
    >
      {/* Full-screen background */}
      {coverUrl ? (
        <div
          className="fixed inset-0 -z-20 bg-cover bg-center scale-[1.06]"
          style={{ backgroundImage: `url(${coverUrl})` }}
        />
      ) : null}

      <div className="fixed inset-0 -z-10 backdrop-blur-[18px]" />

      <div
        className="fixed inset-0 -z-10"
        style={{
          background: `linear-gradient(180deg, rgba(0,0,0,0.38) 0%, rgba(5,7,12,0.48) 40%, rgba(5,7,12,0.88) 100%)`,
        }}
      />

      <div
        className="fixed inset-0 -z-10 pointer-events-none"
        style={{
          background: `radial-gradient(circle at 50% 55%, rgba(${rgb}, 0.12), transparent 48%)`,
        }}
      />

      {/* Header */}
      <section className="relative z-10 px-6 pt-6">
        <div className="mx-auto flex w-full max-w-md flex-col items-center">
          <div className="mb-3 flex h-20 w-20 items-center justify-center overflow-hidden rounded-2xl border border-white/30 bg-white/5">
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logoUrl} alt={restaurantName} className="h-full w-full object-cover" />
            ) : (
              <div className="text-2xl">🍽</div>
            )}
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-white">{restaurantName}</h1>
          {tagline ? <p className="mt-1 text-sm text-white/70">{tagline}</p> : null}

          <div className="mt-3 flex items-center gap-3 text-sm text-white/70">
            {city ? (
              <span className="flex items-center gap-2">
                <MapPin size={14} /> {city}
              </span>
            ) : null}
            {openingLabel ? (
              <span className="flex items-center gap-2">
                <Clock size={14} /> {openingLabel}
              </span>
            ) : null}

            <span className={isOpen ? 'text-emerald-300 flex items-center gap-2' : 'text-red-300 flex items-center gap-2'}>
              <span className={isOpen ? 'h-2.5 w-2.5 rounded-full bg-emerald-400' : 'h-2.5 w-2.5 rounded-full bg-red-500'} />
              {isOpen ? 'Open' : 'Closed'}
            </span>
          </div>
        </div>
      </section>

      {/* TableFlow glass card */}
      <section className="relative z-10 mx-auto mt-8 w-full max-w-md px-6 pb-6">
        <div
          className="relative overflow-hidden rounded-[28px] border border-white/15 bg-white/10 shadow-2xl backdrop-blur-[30px]"
          style={{ boxShadow: `0 25px 80px rgba(0,0,0,.45), 0 0 60px rgba(${rgb},.08)` }}
        >
          {/* Ambient blobs */}
          <div
            className="pointer-events-none absolute -left-24 -top-24 h-64 w-64 rounded-full blur-3xl"
            style={{ backgroundColor: `rgba(${rgb}, .18)` }}
          />
          <div
            className="pointer-events-none absolute -right-24 -bottom-20 h-72 w-72 rounded-full blur-3xl"
            style={{ backgroundColor: `rgba(${rgb}, .16)` }}
          />

          <div className="relative p-6">
            <div className="text-center">
              <p className="text-xs font-medium tracking-wide text-white/60">Powered by</p>
              <div className="mt-2 flex justify-center">
                <div className="text-2xl font-semibold tracking-tight">
                  <span className="text-white">Table</span>
                  <span style={{ color: `rgb(${rgb})` }}>Flow</span>
                </div>
              </div>
              <p className="mt-1 text-[10px] font-semibold tracking-[0.25em] text-white/70">SMART DINING, SIMPLIFIED.</p>
            </div>

            <div className="mt-6 text-center">
              <h2 className="text-lg font-semibold text-white">What is your table number?</h2>
              <p className="mt-2 text-sm text-white/60">You will find it on the stand or card on your table.</p>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); submit(); }} className="mt-6">
              <div
                className="flex h-16 items-center rounded-2xl border border-white/20 bg-black/20 px-4 transition-shadow"
                style={{ boxShadow: focused ? `0 0 0 4px rgba(${rgb}, .14)` : tableNumber.length > 0 ? `0 0 0 1px rgba(${rgb}, .48)` : 'none' }}
              >
                <Utensils size={20} className="text-white/80" />

                <input
                  ref={inputRef}
                  value={tableNumber}
                  onChange={(e) => { setTableNumber(e.target.value.toUpperCase().slice(0, 10)); setError(null); }}
                  onFocus={() => setFocused(true)}
                  onBlur={() => setFocused(false)}
                  inputMode="numeric"
                  placeholder="5"
                  aria-label="Table number"
                  aria-describedby={error ? 'table-error' : undefined}
                  className="ml-4 w-full bg-transparent text-center text-3xl font-semibold outline-none placeholder:text-white/30 text-white"
                />
              </div>

              {error ? (
                <div className="mt-3">
                  <Alert variant="destructive" className="text-center">{error}</Alert>
                </div>
              ) : null}

              <Button type="button" size="xl" className="mt-4 w-full flex items-center justify-center gap-2" onClick={() => submit()} disabled={pending}>
                Continue to the menu <ArrowRight />
              </Button>
            </form>

            <div className="mt-6 grid grid-cols-4 gap-3">
              <Feature icon={<QrCode size={18} />} label="Scan" color={rgb} />
              <Feature icon={<Utensils size={18} />} label="Order" color={rgb} />
              <Feature icon={<Search size={18} />} label="Track" color={rgb} />
              <Feature icon={<CreditCard size={18} />} label="Pay" color={rgb} />
            </div>

            <p className="mt-6 text-center text-xs text-white/60">No app, no sign-up. Order straight from your phone.</p>
          </div>
        </div>
      </section>

    </main>
  )
}

function Feature({ icon, label, color }: { icon: React.ReactNode; label: string; color: string }) {
  return (
    <div className="flex flex-col items-center gap-2 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-white/10 bg-white/[0.03] text-white" style={{ boxShadow: `0 0 20px rgba(${color}, .08)` }}>
        {icon}
      </div>
      <span className="text-xs text-white/70">{label}</span>
    </div>
  )
}
