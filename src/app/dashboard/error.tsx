'use client'

import * as React from 'react'
import { AlertTriangle, RotateCw } from 'lucide-react'

import { Button } from '@/components/ui/button'

/**
 * Dashboard error boundary.
 *
 * Without this a failing server component renders Next's white "Application
 * error" page with only a digest, which tells the person looking at it nothing
 * and tells whoever has to fix it almost nothing. This keeps the user inside
 * the app, names the page that failed, and shows the digest next to a plain
 * instruction for finding the matching server log — the digest is the only
 * thing that links the two.
 *
 * The message itself is only shown in development. In production Next strips
 * it deliberately, because an unfiltered database error can leak table and
 * column names to anyone who can load the page.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  React.useEffect(() => {
    // Goes to the server log with the digest attached, so the two can be matched.
    console.error('[dashboard]', error.digest, error.message)
  }, [error])

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <AlertTriangle className="mx-auto h-10 w-10 text-amber-500" />
      <h1 className="mt-4 text-lg font-semibold">This page could not load</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Something went wrong fetching the data for this screen. The rest of the dashboard is
        unaffected.
      </p>

      {process.env.NODE_ENV !== 'production' && (
        <pre className="mt-4 overflow-x-auto rounded-lg border border-border bg-muted p-3 text-left text-xs">
          {error.message}
        </pre>
      )}

      <p className="mt-4 text-sm">
        <a href="/api/health/db" className="text-primary underline underline-offset-2">
          Check the database matches this build
        </a>{' '}
        <span className="text-muted-foreground">— the usual cause is a deploy that shipped ahead of its migration.</span>
      </p>

      {error.digest && (
        <p className="mt-4 text-xs text-muted-foreground">
          Reference <code className="rounded bg-muted px-1.5 py-0.5">{error.digest}</code> — search
          this in your hosting logs to find the underlying error.
        </p>
      )}

      <div className="mt-6 flex justify-center gap-2">
        <Button onClick={reset}>
          <RotateCw className="mr-2 h-4 w-4" />
          Try again
        </Button>
        <Button variant="outline" asChild>
          <a href="/dashboard">Back to dashboard</a>
        </Button>
      </div>
    </div>
  )
}
