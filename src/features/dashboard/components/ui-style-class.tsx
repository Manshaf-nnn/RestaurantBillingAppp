'use client'

import * as React from 'react'

/**
 * Mirror the interface-style class onto `<html>`.
 *
 * ── Why the shell's own class is not enough ─────────────────────────────────
 *
 * Radix portals every dialog, popover, dropdown and tooltip to `<body>`, far
 * outside the shell element the layout puts the class on. So the skin reached
 * the page and stopped at the edge of anything that floats over it — which is
 * most of the controls worth looking at.
 *
 * ── Why this is not a flash ─────────────────────────────────────────────────
 *
 * The server already renders the class on the shell, so everything in the
 * document flow is correct in the first painted frame. This only adds the
 * class for portalled content, and nothing is portalled until somebody opens
 * it — which cannot happen before hydration. Setting it in an effect is
 * therefore free, and reading a cookie in the root layout (the alternative)
 * would make every page in the app dynamic, including the guest menu.
 *
 * Removed on unmount, so leaving the dashboard for the till or the kitchen
 * does not leave the class behind on a screen that never asked for it.
 */
export function UiStyleClass({ style }: { style: 'classic' | 'modern' }) {
  React.useEffect(() => {
    if (style !== 'modern') return
    const root = document.documentElement
    root.classList.add('ui-modern')
    return () => root.classList.remove('ui-modern')
  }, [style])

  return null
}
