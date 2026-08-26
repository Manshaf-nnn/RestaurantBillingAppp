'use client'

import * as React from 'react'
import { Loader2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { OrderDetail } from '@/features/orders/components/order-detail'
import { fetchOrderDetail } from '@/features/orders/actions-fetch'
import { callAction } from '@/lib/use-action'

/**
 * Exactly the prop bag the action returns.
 *
 * Derived from the action rather than re-declared, so a field added or renamed
 * on the server is a compile error here instead of an undefined at runtime.
 */
type Loaded = Extract<Awaited<ReturnType<typeof fetchOrderDetail>>, { ok: true }>['data']

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; data: Loaded }
  | { status: 'error'; message: string }

/**
 * An order, over the floor plan.
 *
 * ── Why it is memoised ──────────────────────────────────────────────────────
 *
 * The board re-renders every second so its counters can tick. This subtree is
 * the whole order-detail renderer, and it reads no clock — so without `memo` it
 * would re-render sixty times a minute inside a modal on a floor tablet, for
 * nothing.
 *
 * ── The two failures that only happen on a real floor ───────────────────────
 *
 * A manager taps one table then another a moment later, and the first request —
 * slower, because it was first — lands last and overwrites the order they are
 * now looking at. The `stale` flag closes that.
 *
 * And the dialog is given an id rather than reading the selected table: an
 * order that completes leaves the board on the next refresh, and anything
 * derived from the selection would quietly swap in a different party's bill
 * under an unchanged modal.
 */
export const OrderDialog = React.memo(function OrderDialog({
  orderId,
  onClose,
}: {
  orderId: string | null
  onClose: () => void
}) {
  const [state, setState] = React.useState<State>({ status: 'idle' })
  const [attempt, setAttempt] = React.useState(0)

  React.useEffect(() => {
    if (!orderId) {
      setState({ status: 'idle' })
      return
    }

    let stale = false
    setState({ status: 'loading' })

    void callAction(() => fetchOrderDetail(orderId)).then((result) => {
      if (stale) return
      setState(
        result.ok
          ? { status: 'ready', data: result.data }
          : { status: 'error', message: result.error },
      )
    })

    return () => {
      stale = true
    }
  }, [orderId, attempt])

  return (
    <Dialog open={orderId !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent size="xl">
        {/*
          Unconditional and first: Radix drops `aria-labelledby` without a
          title, and the order number is not known until the fetch resolves.
        */}
        <DialogTitle className="sr-only">Order details</DialogTitle>

        {state.status === 'loading' || state.status === 'idle' ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Loading the order…
          </div>
        ) : state.status === 'error' ? (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <p className="text-sm text-destructive">{state.message}</p>
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </Button>
          </div>
        ) : (
          /*
           * `backHref={null}` drops the "back to orders" arrow, which belongs
           * on a page and not in a modal opened from somewhere else. Everything
           * else is the same renderer the order page uses — and it arrives
           * read-only because the action says so, not because of anything here.
           */
          <OrderDetail {...state.data} backHref={null} />
        )}
      </DialogContent>
    </Dialog>
  )
})
