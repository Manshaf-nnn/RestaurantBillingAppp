'use client'

import * as React from 'react'

import { callAction } from '@/lib/use-action'
import { recordQrOpen } from '../actions'

/**
 * "Somebody opened this code" (ar.md §18, §22).
 *
 * ── Why from the browser, and only once ─────────────────────────────────────
 *
 * Counting during a server render would count prefetches, crawlers, uptime
 * probes and the link previews that chat apps generate — an owner would see a
 * hundred "scans" for a card nobody has looked at. Firing once per browser
 * session from the client is the closest honest approximation, which is why
 * the figure is labelled "Opens" and not "Scans": nothing can tell a camera
 * from a forwarded link.
 *
 * `sessionStorage` rather than `localStorage`, so a guest who comes back
 * tomorrow counts again — a second visit IS a second open — while refreshing
 * or moving between the menu and the cart does not.
 */
export function QrOpenBeacon({ code }: { code: string }) {
  React.useEffect(() => {
    const key = `ros:qr-open:${code}`
    try {
      if (sessionStorage.getItem(key)) return
      sessionStorage.setItem(key, '1')
    } catch {
      // Private browsing, or site data blocked. Counting once per page load is
      // a worse figure than counting once per session, but it is not a reason
      // to stop the guest seeing the menu.
    }
    void callAction(() => recordQrOpen({ code }))
  }, [code])

  return null
}
