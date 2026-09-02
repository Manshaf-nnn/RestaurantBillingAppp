import { WifiOff } from 'lucide-react'

export const metadata = { title: 'Offline' }

export default function OfflinePage() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-6 text-center">
      <div className="max-w-sm space-y-4">
        <span className="mx-auto flex size-16 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
          <WifiOff className="size-8" />
        </span>
        <h1 className="text-2xl font-bold tracking-tight">You’re offline</h1>
        {/*
          §81, and honestly. This page used to promise "new data will sync the
          moment you're back online" — there is no offline queue, and an order
          taken on faith in that sentence was simply lost. The truth is less
          comfortable and far safer to act on.
        */}
        <p className="text-balance text-sm text-muted-foreground">
          TableFlow can’t reach the network right now. Nothing entered while
          offline is saved — take orders on paper until the connection is
          back, then key them in. Screens you already opened may still show
          their last-loaded data.
        </p>
      </div>
    </main>
  )
}
