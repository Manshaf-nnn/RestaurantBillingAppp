'use client'

import * as React from 'react'
import { Printer } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { LocalDateTime } from '@/components/local-time'
import type { Denomination } from '../denominations'
import type { DrawerClosure } from '../closure'

/**
 * The closure slip (correctionA.md §4).
 *
 * ── Why it appears only after the close ───────────────────────────────────
 *
 * Everything on it — expected cash, the gap — is withheld while the drawer is
 * being counted, because a cashier who can see the gap can count again until
 * it disappears. Once the close is committed there is nothing left to tune,
 * and a slip without the figures on it would be worth nothing to the person
 * asked to sign it and hand it over with the cash.
 *
 * ── Why it prints rather than downloads ───────────────────────────────────
 *
 * A till has a receipt printer and often no keyboard. `window.print()` with a
 * print stylesheet uses the machine that is already there; a PDF would need
 * somewhere to put a file on a device that has no file manager.
 */
export function ClosurePreview({
  closure,
  denominations,
  branchName,
  registerName,
  money,
  onClose,
}: {
  closure: DrawerClosure | null
  currency: string
  denominations: Denomination[]
  branchName: string | null
  registerName: string | null
  money: (minor: number) => string
  onClose: () => void
}) {
  if (!closure) return null

  const counted = denominations.filter((d) => (closure.counts[String(d.value)] ?? 0) > 0)
  const short = closure.variance < 0

  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent size="default" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Drawer closed</DialogTitle>
        </DialogHeader>

        {/*
          `print-slip` is what the stylesheet keeps; everything else on the
          page is hidden when printing. See globals.css.
        */}
        <div className="print-slip space-y-4 text-sm">
          <header>
            <p className="text-base font-bold">{closure.sessionNumber}</p>
            <p className="text-muted-foreground">
              {[branchName, registerName].filter(Boolean).join(' · ')}
              {branchName || registerName ? ' · ' : ''}
              <LocalDateTime value={closure.closedAt} />
            </p>
          </header>

          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Counted
            </h3>
            <ul className="divide-y">
              {counted.map((d) => {
                const n = closure.counts[String(d.value)] ?? 0
                return (
                  <li key={d.value} className="flex justify-between py-1 tabular-nums">
                    <span>
                      {d.label} × {n}
                    </span>
                    <span>{money(d.value * n)}</span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-2 flex justify-between border-t pt-2 font-bold tabular-nums">
              <span>Cash counted</span>
              <span>{money(closure.countedCash)}</span>
            </p>
          </section>

          <section>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Expected
            </h3>
            <ul className="space-y-1 tabular-nums">
              <Row label="Opening float" value={money(closure.openingFloat)} />
              <Row label="Cash sales" value={money(closure.cashSales)} />
              <Row label="Cash in" value={money(closure.cashIn)} />
              <Row label="Cash out" value={`−${money(closure.cashOut)}`} />
              <li className="flex justify-between border-t pt-1 font-bold">
                <span>Expected in drawer</span>
                <span>{money(closure.expectedCash)}</span>
              </li>
            </ul>
          </section>

          <section className="rounded-lg border p-3">
            <p className="flex items-center justify-between font-bold tabular-nums">
              <span>Difference</span>
              <span
                className={
                  closure.variance === 0
                    ? 'text-emerald-600'
                    : short
                      ? 'text-destructive'
                      : 'text-amber-600'
                }
              >
                {closure.variance === 0
                  ? 'Balanced exactly'
                  : `${short ? 'Short' : 'Over'} by ${money(Math.abs(closure.variance))}`}
              </span>
            </p>
            {closure.needsReview ? (
              <p className="mt-2 text-xs text-muted-foreground">
                <Badge variant="warning">Waiting for a manager</Badge>{' '}
                This drawer is held until somebody senior signs the difference off.
              </p>
            ) : null}
          </section>

          <p className="border-t pt-3 text-xs text-muted-foreground">
            Counted by ____________________ Received by ____________________
          </p>
        </div>

        <div className="mt-4 flex gap-2 print:hidden">
          <Button onClick={() => window.print()}>
            <Printer /> Print
          </Button>
          <Button variant="outline" onClick={onClose}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <li className="flex justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span>{value}</span>
    </li>
  )
}
