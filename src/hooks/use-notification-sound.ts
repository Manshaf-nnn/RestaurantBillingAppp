'use client'

import * as React from 'react'

/**
 * Kitchen alert tone, synthesised with the Web Audio API.
 *
 * Generating it in-browser avoids shipping an audio asset and keeps the sound
 * crisp at any volume. Browsers block audio until the user interacts with the
 * page, so the context is created lazily on first play and unlocked by the
 * first click anywhere in the document.
 */
export function useNotificationSound(enabled = true) {
  const contextRef = React.useRef<AudioContext | null>(null)
  const unlockedRef = React.useRef(false)

  const ensureContext = React.useCallback(() => {
    if (typeof window === 'undefined') return null
    if (!contextRef.current) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      contextRef.current = new Ctor()
    }
    return contextRef.current
  }, [])

  React.useEffect(() => {
    const unlock = () => {
      const ctx = ensureContext()
      if (ctx && ctx.state === 'suspended') void ctx.resume()
      unlockedRef.current = true
    }
    window.addEventListener('pointerdown', unlock, { once: true })
    window.addEventListener('keydown', unlock, { once: true })
    return () => {
      window.removeEventListener('pointerdown', unlock)
      window.removeEventListener('keydown', unlock)
    }
  }, [ensureContext])

  React.useEffect(
    () => () => {
      void contextRef.current?.close()
      contextRef.current = null
    },
    [],
  )

  /** Two-note chime — cuts through kitchen noise without being harsh. */
  const play = React.useCallback(
    (variant: 'new-order' | 'ready' | 'alert' = 'new-order') => {
      if (!enabled) return
      const ctx = ensureContext()
      if (!ctx) return
      if (ctx.state === 'suspended') void ctx.resume()

      const notes =
        variant === 'new-order'
          ? [880, 1174.66]
          : variant === 'ready'
            ? [659.25, 987.77]
            : [523.25, 523.25]

      const start = ctx.currentTime
      notes.forEach((frequency, index) => {
        const oscillator = ctx.createOscillator()
        const gain = ctx.createGain()

        oscillator.type = 'sine'
        oscillator.frequency.setValueAtTime(frequency, start + index * 0.16)

        gain.gain.setValueAtTime(0, start + index * 0.16)
        gain.gain.linearRampToValueAtTime(0.28, start + index * 0.16 + 0.02)
        gain.gain.exponentialRampToValueAtTime(0.0001, start + index * 0.16 + 0.4)

        oscillator.connect(gain).connect(ctx.destination)
        oscillator.start(start + index * 0.16)
        oscillator.stop(start + index * 0.16 + 0.45)
      })

      // A short vibration on handheld devices carried by waiters.
      if (variant !== 'alert' && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate?.([120, 60, 120])
      }
    },
    [enabled, ensureContext],
  )

  return { play }
}
