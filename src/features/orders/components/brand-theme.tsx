'use client'

import * as React from 'react'

import { cn } from '@/lib/utils'

/**
 * Derives the guest app's accent from the restaurant's own artwork.
 *
 * The owner uploads a logo and a cover photo; those are the only brand assets
 * the platform ever has. Rather than ship one orange for every restaurant, the
 * dominant saturated colour is sampled from the logo (falling back to the cover)
 * and published as CSS custom properties, so a blue seafood place and a green
 * salad bar each get a guest app that looks like theirs.
 *
 * Sampling weights each pixel by its saturation, because the interesting colour
 * in a logo is almost never the white or black it sits on.
 */

const FALLBACK = { r: 249, g: 115, b: 22 } // the TableFlow orange

export interface Rgb {
  r: number
  g: number
  b: number
}

export async function sampleBrandColor(url: string | null): Promise<Rgb> {
  if (!url) return FALLBACK
  try {
    const image = new window.Image()
    image.crossOrigin = 'anonymous'
    image.src = url
    await new Promise((resolve, reject) => {
      image.onload = resolve
      image.onerror = reject
    })

    const size = 48
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) return FALLBACK
    context.drawImage(image, 0, 0, size, size)

    const { data } = context.getImageData(0, 0, size, size)
    let r = 0
    let g = 0
    let b = 0
    let weightTotal = 0

    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 100) continue // ignore transparent padding
      const rr = data[i]
      const gg = data[i + 1]
      const bb = data[i + 2]
      const max = Math.max(rr, gg, bb)
      const min = Math.min(rr, gg, bb)
      const saturation = max === 0 ? 0 : (max - min) / max
      // Near-greys carry no brand information — down-weight them hard.
      const weight = saturation ** 2 * 3 + 0.05
      r += rr * weight
      g += gg * weight
      b += bb * weight
      weightTotal += weight
    }

    if (!weightTotal) return FALLBACK
    return normalise({
      r: Math.round(r / weightTotal),
      g: Math.round(g / weightTotal),
      b: Math.round(b / weightTotal),
    })
  } catch {
    // Cross-origin images without CORS headers taint the canvas; that is a
    // normal outcome for a pasted URL, not an error worth surfacing.
    return FALLBACK
  }
}

/**
 * Keep the sampled colour usable as an accent on a dark ground: a muddy or very
 * dark average would disappear against the glass, and a near-white one would
 * glare. This lifts saturation and clamps lightness without changing the hue.
 */
function normalise({ r, g, b }: Rgb): Rgb {
  const [h, s, l] = rgbToHsl(r, g, b)
  const saturation = Math.min(1, Math.max(s, 0.55))
  const lightness = Math.min(0.68, Math.max(l, 0.48))
  return hslToRgb(h, saturation, lightness)
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]

  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / d + 2) / 6
  else h = ((rn - gn) / d + 4) / 6
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  if (s === 0) {
    const v = Math.round(l * 255)
    return { r: v, g: v, b: v }
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const channel = (t: number) => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return {
    r: Math.round(channel(h + 1 / 3) * 255),
    g: Math.round(channel(h) * 255),
    b: Math.round(channel(h - 1 / 3) * 255),
  }
}

/**
 * Wraps the guest ordering screens in the restaurant's colour and its cover
 * photo, so the menu reads as a continuation of the landing screen rather than
 * a generic list the guest lands on after it.
 */
export function BrandTheme({
  logoUrl,
  coverUrl,
  children,
  className,
}: {
  logoUrl: string | null
  coverUrl: string | null
  children: React.ReactNode
  className?: string
}) {
  const [brand, setBrand] = React.useState<Rgb>(FALLBACK)
  const source = logoUrl || coverUrl

  React.useEffect(() => {
    let active = true
    void sampleBrandColor(source).then((colour) => {
      if (active) setBrand(colour)
    })
    return () => {
      active = false
    }
  }, [source])

  const backdrop = coverUrl || '/default-cover.jpg'

  return (
    /*
     * `isolate` + an opaque base of its own.
     *
     * This sits inside the shared order layout, which paints an opaque
     * background. A backdrop at a negative z-index would therefore be painted
     * behind *that* and never seen — which silently turns the glass surfaces
     * below into plain white cards carrying white text. Owning a stacking
     * context and a ground colour here means the treatment holds wherever the
     * component is mounted.
     */
    <div
      className={cn('relative isolate min-h-dvh bg-zinc-50 dark:bg-[#08090c]', className)}
      style={
        {
          '--brand': `${brand.r} ${brand.g} ${brand.b}`,
          '--brand-r': brand.r,
          '--brand-g': brand.g,
          '--brand-b': brand.b,
        } as React.CSSProperties
      }
    >
      {/*
        Fixed, not absolute: the ambient photo stays put while the menu scrolls
        over it. Heavily blurred and darkened so it reads as atmosphere and
        never competes with the food photography or the prices.
      */}
      <div aria-hidden="true" className="pointer-events-none fixed inset-0 z-0">
        <div
          className="absolute inset-0 scale-110 bg-cover bg-center"
          style={{ backgroundImage: `url(${backdrop})` }}
        />
        <div className="absolute inset-0 backdrop-blur-2xl" />
        {/* Scrim flips with the theme — see .guest-scrim in globals.css. */}
        <div className="guest-scrim absolute inset-0" />
        <div
          className="absolute inset-0"
          style={{
            background: `radial-gradient(120% 60% at 50% 0%, rgba(var(--brand-r),var(--brand-g),var(--brand-b),0.18), transparent 70%)`,
          }}
        />
      </div>

      <div className="relative z-10">{children}</div>
    </div>
  )
}
