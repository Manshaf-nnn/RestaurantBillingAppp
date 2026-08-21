'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Plus, Trash2 } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EmptyState } from '@/components/ui/feedback'
import { Input, Textarea } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LocalDateTime } from '@/components/local-time'
import { SectionCard, StatCard } from '@/features/dashboard/components/page-header'
import { SupplierPricing } from '@/features/purchasing/components/supplier-pricing'
import type { SupplierPricingData } from '@/features/purchasing/queries'
import { formatMoney } from '@/lib/money'
import { useAction } from '@/lib/use-action'
import { deleteSupplierPaymentAction, recordSupplierPaymentAction } from '../actions'
import type { SupplierLedger } from '../ledger'

const METHODS = [
  ['CASH', 'Cash'],
  ['BANK_TRANSFER', 'Bank transfer'],
  ['CARD', 'Card'],
  ['QR', 'QR'],
  ['ONLINE', 'Online'],
  ['WALLET', 'Wallet'],
] as const

const TABS = [
  ['OVERVIEW', 'Overview'],
  ['PURCHASES', 'Purchases'],
  ['PAYMENTS', 'Payments'],
  ['LEDGER', 'Ledger'],
  ['PRICES', 'Price list'],
] as const

type Tab = (typeof TABS)[number][0]

/**
 * Everything about one supplier.
 *
 * This page used to be a price list and nothing else — no orders, no
 * deliveries, no payments, no balance. An owner could see what a supplier
 * charges and had no way to answer "how much do we owe them", because until now
 * nothing in the system could record a payment at all.
 *
 * The ledger is the point of the screen. Every reference in it is a link, so a
 * statement can be read backwards: a figure → the delivery it came from → the
 * order behind that → the items on it.
 */
export function SupplierProfile({
  ledger,
  pricing,
  currency,
  canPay,
}: {
  ledger: SupplierLedger
  pricing: SupplierPricingData
  currency: string
  canPay: boolean
}) {
  const [tab, setTab] = React.useState<Tab>('OVERVIEW')
  const money = (m: number) => formatMoney(m, currency)

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Outstanding"
          value={money(ledger.totals.outstanding)}
          tone={ledger.totals.outstanding > 0 ? 'warning' : 'success'}
          hint={
            ledger.totals.outstanding < 0
              ? 'They are in credit'
              : ledger.totals.outstanding === 0
                ? 'Settled in full'
                : undefined
          }
        />
        <StatCard label="Received to date" value={money(ledger.totals.received)} />
        <StatCard label="Paid to date" value={money(ledger.totals.paid)} />
        <StatCard
          label="Still on order"
          value={money(ledger.totals.onOrder)}
          hint="Ordered, not yet delivered — not owed"
        />
      </div>

      <div className="mb-5 inline-flex flex-wrap rounded-lg border border-border bg-muted/40 p-1">
        {TABS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              tab === value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'OVERVIEW' ? <Overview ledger={ledger} money={money} /> : null}
      {tab === 'PURCHASES' ? <Purchases ledger={ledger} money={money} /> : null}
      {tab === 'PAYMENTS' ? (
        <Payments ledger={ledger} money={money} canPay={canPay} currency={currency} />
      ) : null}
      {tab === 'LEDGER' ? <Ledger ledger={ledger} money={money} /> : null}
      {tab === 'PRICES' ? <SupplierPricing data={pricing} /> : null}
    </>
  )
}

function Overview({
  ledger,
  money,
}: {
  ledger: SupplierLedger
  money: (m: number) => string
}) {
  const { supplier } = ledger

  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <SectionCard title="Contact" className="lg:col-span-2">
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          <Detail label="Trading name">{supplier.name}</Detail>
          <Detail label="Company">{supplier.company ?? '—'}</Detail>
          <Detail label="Contact person">{supplier.contactName ?? '—'}</Detail>
          <Detail label="Phone">
            {supplier.phone ? (
              <a href={`tel:${supplier.phone}`} className="text-primary hover:underline">
                {supplier.phone}
              </a>
            ) : (
              '—'
            )}
          </Detail>
          {/* Email and tax number were fetched and never rendered. */}
          <Detail label="Email">
            {supplier.email ? (
              <a href={`mailto:${supplier.email}`} className="text-primary hover:underline">
                {supplier.email}
              </a>
            ) : (
              '—'
            )}
          </Detail>
          <Detail label="Tax number">{supplier.taxNumber ?? '—'}</Detail>
          <Detail label="Payment terms">
            {supplier.paymentTerms.replace(/_/g, ' ').toLowerCase()}
            {supplier.paymentTermsNote ? ` — ${supplier.paymentTermsNote}` : ''}
          </Detail>
          <Detail label="Status">
            {supplier.isActive ? 'Active' : <Badge variant="secondary">Inactive</Badge>}
          </Detail>
          <Detail label="Address" className="sm:col-span-2">
            {supplier.address ?? '—'}
          </Detail>
          {supplier.notes ? (
            <Detail label="Notes" className="sm:col-span-2">
              {supplier.notes}
            </Detail>
          ) : null}
        </dl>
      </SectionCard>

      <SectionCard title="Account">
        <dl className="space-y-2.5 text-sm">
          <Row label="Received">{money(ledger.totals.received)}</Row>
          <Row label="Paid">−{money(ledger.totals.paid)}</Row>
          <Row label="Returned">−{money(ledger.totals.returned)}</Row>
          <div className="border-t border-border pt-2.5">
            <Row label="Outstanding">
              <strong>{money(ledger.totals.outstanding)}</strong>
            </Row>
          </div>
        </dl>
        <p className="mt-4 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
          What is owed is the value of goods actually <strong>received</strong>, less payments and
          returns. An order that has not been delivered is a promise, not a debt — it is counted
          separately as &ldquo;still on order&rdquo;.
        </p>
      </SectionCard>
    </div>
  )
}

function Purchases({ ledger, money }: { ledger: SupplierLedger; money: (m: number) => string }) {
  return (
    <SectionCard
      title="Purchase orders"
      description="Everything raised with this supplier, and how much of each has actually arrived."
    >
      {ledger.purchases.length === 0 ? (
        <EmptyState
          title="No orders yet"
          description="Orders raised with this supplier appear here with what has been delivered against each."
        />
      ) : (
        <div className="-mx-2 overflow-x-auto px-2">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="pb-2 pr-3 font-medium">Order</th>
                <th className="pb-2 pr-3 font-medium">Raised</th>
                <th className="pb-2 pr-3 font-medium">Status</th>
                <th className="pb-2 pr-3 font-medium">For</th>
                <th className="pb-2 pr-3 text-right font-medium">Ordered</th>
                <th className="pb-2 text-right font-medium">Received</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {ledger.purchases.map((po) => (
                <tr key={po.id}>
                  <td className="py-2.5 pr-3">
                    <Link
                      href={`/dashboard/purchases/${po.id}`}
                      className="font-medium tabular-nums hover:underline"
                    >
                      {po.number}
                    </Link>
                    <p className="text-xs text-muted-foreground">
                      {po.lineCount} item{po.lineCount === 1 ? '' : 's'}
                      {po.receiptCount > 0
                        ? ` · ${po.receiptCount} deliver${po.receiptCount === 1 ? 'y' : 'ies'}`
                        : ''}
                    </p>
                  </td>
                  <td className="py-2.5 pr-3 text-muted-foreground">
                    <LocalDateTime value={po.createdAt} />
                  </td>
                  <td className="py-2.5 pr-3">
                    <Badge variant="secondary">{po.status.replace(/_/g, ' ').toLowerCase()}</Badge>
                  </td>
                  <td className="py-2.5 pr-3 text-muted-foreground">{po.branchName ?? '—'}</td>
                  <td className="py-2.5 pr-3 text-right tabular-nums text-muted-foreground">
                    {money(po.total)}
                  </td>
                  <td className="py-2.5 text-right tabular-nums">{money(po.receivedValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {ledger.receipts.length > 0 ? (
        <>
          <p className="mb-2 mt-6 text-sm font-medium">Deliveries</p>
          <ul className="divide-y divide-border">
            {ledger.receipts.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <Link
                  href={`/dashboard/purchases/${r.purchaseId}/receipts/${r.id}`}
                  className="font-medium tabular-nums hover:underline"
                >
                  {r.number}
                </Link>
                <Link
                  href={`/dashboard/purchases/${r.purchaseId}`}
                  className="tabular-nums text-muted-foreground hover:underline"
                >
                  {r.purchaseNumber}
                </Link>
                {r.branchName ? <Badge variant="secondary">{r.branchName}</Badge> : null}
                {r.supplierRef ? (
                  <span className="text-xs text-muted-foreground">Inv {r.supplierRef}</span>
                ) : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  <LocalDateTime value={r.receivedAt} />
                </span>
                <span className="tabular-nums">{money(r.value)}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </SectionCard>
  )
}

function Payments({
  ledger,
  money,
  canPay,
  currency,
}: {
  ledger: SupplierLedger
  money: (m: number) => string
  canPay: boolean
  currency: string
}) {
  const { busy, run } = useAction()
  const router = useRouter()
  const [open, setOpen] = React.useState(false)
  const [form, setForm] = React.useState({
    amount: '',
    method: 'CASH' as (typeof METHODS)[number][0],
    reference: '',
    notes: '',
    paidAt: '',
    purchaseId: '',
  })

  const save = () =>
    run(
      () =>
        recordSupplierPaymentAction({
          supplierId: ledger.supplier.id,
          amount: Number(form.amount),
          method: form.method,
          reference: form.reference,
          notes: form.notes,
          paidAt: form.paidAt,
          purchaseId: form.purchaseId,
        }),
      {
        success: 'Payment recorded.',
        onDone: () => {
          setOpen(false)
          setForm({ amount: '', method: 'CASH', reference: '', notes: '', paidAt: '', purchaseId: '' })
          router.refresh()
        },
      },
    )

  const remove = (paymentId: string) =>
    run(() => deleteSupplierPaymentAction({ paymentId }), {
      success: 'Payment removed.',
      onDone: () => router.refresh(),
    })

  return (
    <>
      <SectionCard
        title="Payments"
        description="Money paid to this supplier. Everything here reduces what is outstanding."
        actions={
          canPay ? (
            <Button size="sm" onClick={() => setOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Record payment
            </Button>
          ) : null
        }
      >
        {ledger.payments.length === 0 ? (
          <EmptyState
            title="No payments recorded"
            description={
              canPay
                ? 'Record what you pay and the outstanding balance keeps itself up to date.'
                : 'Nothing has been paid to this supplier yet.'
            }
          />
        ) : (
          <ul className="divide-y divide-border">
            {ledger.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <span className="font-medium tabular-nums">{money(p.amount)}</span>
                <Badge variant="secondary">{p.method.replace(/_/g, ' ').toLowerCase()}</Badge>
                {p.reference ? <span className="text-muted-foreground">{p.reference}</span> : null}
                {p.purchaseId && p.purchaseNumber ? (
                  <Link
                    href={`/dashboard/purchases/${p.purchaseId}`}
                    className="tabular-nums text-primary hover:underline"
                  >
                    {p.purchaseNumber}
                  </Link>
                ) : (
                  <span className="text-xs text-muted-foreground">on account</span>
                )}
                {p.notes ? <span className="text-xs text-muted-foreground">{p.notes}</span> : null}
                <span className="ml-auto text-xs text-muted-foreground">
                  <LocalDateTime value={p.paidAt} /> · {p.createdByName}
                </span>
                {canPay ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => remove(p.id)}
                    disabled={busy}
                    aria-label="Remove payment"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Record a payment</DialogTitle>
            <DialogDescription>
              To {ledger.supplier.name}. Outstanding right now is{' '}
              {money(ledger.totals.outstanding)}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Amount ({currency})</Label>
                <Input
                  inputMode="decimal"
                  value={form.amount}
                  onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
                  placeholder="30000"
                />
              </div>
              <div>
                <Label>Method</Label>
                <select
                  className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                  value={form.method}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, method: e.target.value as typeof f.method }))
                  }
                >
                  {METHODS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Reference (optional)</Label>
                <Input
                  value={form.reference}
                  onChange={(e) => setForm((f) => ({ ...f, reference: e.target.value }))}
                  placeholder="Cheque or transfer number"
                />
              </div>
              <div>
                <Label>Date paid</Label>
                <Input
                  type="date"
                  value={form.paidAt}
                  onChange={(e) => setForm((f) => ({ ...f, paidAt: e.target.value }))}
                />
              </div>
            </div>

            <div>
              <Label>Against an order (optional)</Label>
              <select
                className="h-10 w-full rounded-lg border border-input bg-background px-2 text-sm"
                value={form.purchaseId}
                onChange={(e) => setForm((f) => ({ ...f, purchaseId: e.target.value }))}
              >
                <option value="">On account — not a specific order</option>
                {ledger.purchases.map((po) => (
                  <option key={po.id} value={po.id}>
                    {po.number} — {money(po.receivedValue)} received
                  </option>
                ))}
              </select>
              <p className="mt-1 text-xs text-muted-foreground">
                Leave this alone for a lump sum. Attaching it to an order does not change the
                balance — it only makes the statement easier to read.
              </p>
            </div>

            <div>
              <Label>Notes (optional)</Label>
              <Textarea
                rows={2}
                value={form.notes}
                onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={save} disabled={busy || !(Number(form.amount) > 0)}>
              {busy ? 'Saving…' : 'Record payment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function Ledger({ ledger, money }: { ledger: SupplierLedger; money: (m: number) => string }) {
  return (
    <SectionCard
      title="Statement"
      description="Every document, in order, with the running balance. A delivery increases what is owed; a payment or a return reduces it."
    >
      <div className="-mx-2 overflow-x-auto px-2">
        <table className="w-full min-w-[46rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
              <th className="pb-2 pr-3 font-medium">Date</th>
              <th className="pb-2 pr-3 font-medium">Reference</th>
              <th className="pb-2 pr-3 font-medium">Description</th>
              <th className="pb-2 pr-3 text-right font-medium">Debit</th>
              <th className="pb-2 pr-3 text-right font-medium">Credit</th>
              <th className="pb-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {ledger.entries.map((entry) => (
              <tr key={entry.id}>
                <td className="py-2.5 pr-3 text-muted-foreground">
                  <LocalDateTime value={entry.date} />
                </td>
                <td className="py-2.5 pr-3">
                  {entry.href ? (
                    <Link href={entry.href} className="tabular-nums text-primary hover:underline">
                      {entry.reference}
                    </Link>
                  ) : (
                    <span className="tabular-nums">{entry.reference}</span>
                  )}
                </td>
                <td className="py-2.5 pr-3 text-muted-foreground">{entry.description}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">
                  {entry.debit > 0 ? money(entry.debit) : '—'}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums">
                  {entry.credit > 0 ? money(entry.credit) : '—'}
                </td>
                <td className="py-2.5 text-right font-medium tabular-nums">
                  {money(entry.balance)}
                </td>
              </tr>
            ))}
            <tr className="font-medium">
              <td className="pt-3" colSpan={5}>
                Outstanding
              </td>
              <td className="pt-3 text-right tabular-nums">{money(ledger.totals.outstanding)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {ledger.totals.onOrder > 0 ? (
        <p className="mt-3 border-l-2 border-border pl-3 text-sm text-muted-foreground">
          A further {money(ledger.totals.onOrder)} is on order and has not been delivered. It is
          not owed and is deliberately not in the balance above.
        </p>
      ) : null}
    </SectionCard>
  )
}

function Detail({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={className}>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{children}</dd>
    </div>
  )
}
