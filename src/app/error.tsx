'use client'

import * as React from 'react'

/**
 * Root error boundary.
 *
 * `dashboard/error.tsx` cannot catch a failure in `dashboard/layout.tsx` —
 * a layout error bubbles past its own segment's boundary to the parent. Without
 * this file that landed on Next's bare white "Application error" page, which
 * is exactly what was being seen and gives the reader nothing to act on.
 */
export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  React.useEffect(() => {
    console.error('[root]', error.digest, error.message)
  }, [error])

  return (
    <main style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: '2rem', background: '#0b0d12', color: '#e6e8ee', fontFamily: 'system-ui, sans-serif' }}>
      <div style={{ maxWidth: '30rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '1.125rem', fontWeight: 600, margin: 0 }}>Something went wrong</h1>
        <p style={{ marginTop: '0.75rem', fontSize: '0.875rem', opacity: 0.7 }}>
          The page could not be loaded. This is usually temporary.
        </p>
        <p style={{ marginTop: '1rem', fontSize: '0.8125rem' }}>
          <a href="/api/health/db" style={{ color: '#f97316' }}>Check the database matches this build</a>
        </p>
        {error.digest && (
          <p style={{ marginTop: '0.75rem', fontSize: '0.75rem', opacity: 0.55 }}>
            Reference <code>{error.digest}</code>
          </p>
        )}
        <div style={{ marginTop: '1.5rem', display: 'flex', gap: '0.5rem', justifyContent: 'center' }}>
          <button onClick={reset} style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem', border: 'none', background: '#f97316', color: '#fff', cursor: 'pointer' }}>
            Try again
          </button>
          <a href="/dashboard" style={{ padding: '0.5rem 1rem', borderRadius: '0.5rem', border: '1px solid #2a2f3a', color: '#e6e8ee', textDecoration: 'none' }}>
            Dashboard
          </a>
        </div>
      </div>
    </main>
  )
}
