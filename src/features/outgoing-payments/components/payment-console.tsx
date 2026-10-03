'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

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
import { Input, Textarea } from '@/components/ui/input'
import { Field } from '@/components/ui/label'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { formatMoney } from '@/lib/money'
import { METHOD_LABELS } from '@/features/payments/destinations'
import {
  cancelPaymentAction,
  markPaidAction,
  saveDraftAction,
  submitPaymentAction,
} from '../actions'
import type { OutgoingRow } from '../queries'

/**
 * The accountant's worklist: draft it, submit it, and — once the owner has
 * signed it — pay it. Every status is a tab; every row says where it stands
 * and what happened to it last.
 */

const STATUS_META: Record<string, { label: string; tone: 'secondary' | 'outline' | 'destructive' }> = {
  DRAFT: { label: 'Draft', tone: 'outline' },
  SUBMITTED: { label: 'Waiting for approval', tone: 'secondary' },
  APPROVED: { label: 'Approved — pay it', tone: 'secondary' },
  REJECTED: { label: 'Rejected', tone: 'destructive' },
  PAID: { label: 'Paid', tone: 'secondary' },
  REVERSED: { label: 'Reversed', tone: 'destructive' },
  CANCELLED: { label: 'Cancelled', tone: 'outline' },
}

const TABS = ['ALL', 'DRAFT', 'SUBMITTED', 'APPROVED', 'PAID', 'REJECTED'] as const

export function PaymentConsole({
  rows,
  suppliers,
  categories,
  branches,
  accounts = [],
  selfApproves = false,
  defaultBranchId,
  currency,
  locale,
  canCreate,
  canPay,
}: {
  rows: OutgoingRow[]
  suppliers: Array<{ id: string; name: string }>
  categories: Array<{ id: string; name: string }>
  branches: Array<{ id: string; name: string }>
  /** The accounts from Payment details, offered as "Pay from". */
  accounts?: Array<{ id: string; name: string }>
  /** The owner: their own payment is approved the moment it is submitted. */
  selfApproves?: boolean
  defaultBranchId: string | null
  currency: string
  locale: string
  canCreate: boolean
  canPay: boolean
}) {
  const router = useRouter()
  const money = (value: number) => formatMoney(value, currency, locale)
  const [tab, setTab] = React.useState<(typeof TABS)[number]>('ALL')
  const [createOpen, setCreateOpen] = React.useState(false)
  const [busyId, setBusyId] = React.useState<string | null>(null)

  const visible = rows.filter((row) => tab === 'ALL' || row.status === tab)

  const run = async (id: string, fn: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusyId(id)
    const result = await fn()
    setBusyId(null)
    if (!result.ok) {
      toast.error(result.error ?? 'Something went wrong')
      return
    }
    router.refresh()
  }

  return (
    <SectionCard
      title="Payments out"
      description="Supplier settlements and formal expenses. A submitted payment locks until the owner rules on it."
      actions={
        canCreate ? (
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            New payment
          </Button>
        ) : undefined
      }
    >
      <div className="mb-3 flex flex-wrap gap-1.5">
        {TABS.map((entry) => (
          <Button
            key={entry}
            size="sm"
            variant={tab === entry ? 'default' : 'outline'}
            onClick={() => setTab(entry)}
          >
            {entry === 'ALL' ? 'All' : STATUS_META[entry].label}
          </Button>
        ))}
      </div>

      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing here. {canCreate ? 'Raise a payment with “New payment”.' : ''}
        </p>
      ) : (
        <ul className="divide-y">
          {visible.map((row) => (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-2 font-medium">
                  <span className="font-mono text-xs text-muted-foreground">{row.number}</span>
                  {row.supplierName ?? row.categoryName ?? '—'}
                  <Badge variant={STATUS_META[row.status]?.tone ?? 'outline'}>
                    {STATUS_META[row.status]?.label ?? row.status}
                  </Badge>
                </p>
                <p className="mt-0.5 max-w-[46ch] truncate text-xs text-muted-foreground">
                  {row.description} · {METHOD_LABELS[row.method] ?? row.method}
                  {row.payFromName ? ` from ${row.payFromName}` : ''}
                  {row.reference ? ` · ${row.reference}` : ''} · {row.branchName}
                </p>
                {row.decisionNote ? (
                  <p className="mt-0.5 text-xs italic text-muted-foreground">“{row.decisionNote}”</p>
                ) : null}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-base font-semibold tabular-nums">{money(row.amount)}</span>
                {canCreate && row.status === 'DRAFT' ? (
                  <Button
                    size="sm"
                    loading={busyId === row.id}
                    onClick={() => run(row.id, () => callAction(() => submitPaymentAction({ paymentId: row.id })))}
                  >
                    {selfApproves ? 'Approve' : 'Submit'}
                  </Button>
                ) : null}
                {canPay && row.status === 'APPROVED' ? (
                  <Button
                    size="sm"
                    loading={busyId === row.id}
                    onClick={() => run(row.id, () => callAction(() => markPaidAction({ paymentId: row.id })))}
                  >
                    Mark paid
                  </Button>
                ) : null}
                {canCreate && (row.status === 'DRAFT' || row.status === 'SUBMITTED') ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busyId === row.id}
                    onClick={() => run(row.id, () => callAction(() => cancelPaymentAction({ paymentId: row.id })))}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <NewPaymentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        suppliers={suppliers}
        categories={categories}
        branches={branches}
        accounts={accounts}
        selfApproves={selfApproves}
        defaultBranchId={defaultBranchId}
        currency={currency}
      />
    </SectionCard>
  )
}

function NewPaymentDialog({
  open,
  onOpenChange,
  suppliers,
  categories,
  branches,
  accounts,
  selfApproves,
  defaultBranchId,
  currency,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  suppliers: Array<{ id: string; name: string }>
  categories: Array<{ id: string; name: string }>
  branches: Array<{ id: string; name: string }>
  accounts: Array<{ id: string; name: string }>
  selfApproves: boolean
  defaultBranchId: string | null
  currency: string
}) {
  const router = useRouter()
  const [kind, setKind] = React.useState<'SUPPLIER' | 'EXPENSE'>('EXPENSE')
  const [supplierId, setSupplierId] = React.useState('')
  const [categoryId, setCategoryId] = React.useState('')
  const [branchId, setBranchId] = React.useState(defaultBranchId ?? branches[0]?.id ?? '')
  const [amount, setAmount] = React.useState('')
  const [method, setMethod] = React.useState<'CASH' | 'CARD' | 'BANK_TRANSFER' | 'CHEQUE' | 'QR' | 'ONLINE' | 'WALLET'>('BANK_TRANSFER')
  const [payFromAccountId, setPayFromAccountId] = React.useState('')
  const [reference, setReference] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [paymentDate, setPaymentDate] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [pending, setPending] = React.useState(false)

  /*
   * `send` saves the draft and submits it in one go — the usual case, and the
   * whole flow for an owner, whose own submission is approved on the spot.
   * Saving as a draft stays for a payment somebody is not ready to send.
   */
  const submitDraft = async (send = false) => {
    setPending(true)
    const result = await callAction(() =>
      saveDraftAction({
        kind,
        supplierId: kind === 'SUPPLIER' ? supplierId : '',
        expenseCategoryId: kind === 'EXPENSE' ? categoryId : '',
        branchId,
        amount,
        method,
        payFromAccountId,
        reference,
        description,
        paymentDate,
      }),
    )
    if (!result.ok) {
      setPending(false)
      toast.error(result.error)
      return
    }
    if (send) {
      const sent = await callAction(() => submitPaymentAction({ paymentId: result.data.id }))
      setPending(false)
      if (!sent.ok) {
        // The draft exists; say so, so nobody raises it a second time.
        toast.error(`${result.data.number} was saved as a draft, but could not be submitted: ${sent.error}`)
      } else {
        toast.success(
          sent.data.status === 'APPROVED'
            ? `${result.data.number} approved — ready to pay`
            : `${result.data.number} sent for approval`,
        )
      }
    } else {
      setPending(false)
      toast.success(`Draft ${result.data.number} saved`)
    }
    onOpenChange(false)
    setAmount('')
    setReference('')
    setDescription('')
    router.refresh()
  }

  const selectClass =
    'h-10 w-full rounded-md border bg-background px-3 text-sm'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>New outgoing payment</DialogTitle>
          <DialogDescription>
            {selfApproves
              ? 'Nothing leaves the books until it is paid. As the owner, your payment is approved as soon as you submit it.'
              : 'Nothing leaves the books until it is submitted, approved and paid.'}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="What is this?" htmlFor="op-kind">
            <select id="op-kind" className={selectClass} value={kind} onChange={(e) => setKind(e.target.value as never)}>
              <option value="EXPENSE">Business expense</option>
              <option value="SUPPLIER">Supplier payment</option>
            </select>
          </Field>
          {kind === 'SUPPLIER' ? (
            <Field label="Supplier" htmlFor="op-supplier">
              <select id="op-supplier" className={selectClass} value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
                <option value="">Choose…</option>
                {suppliers.map((supplier) => (
                  <option key={supplier.id} value={supplier.id}>{supplier.name}</option>
                ))}
              </select>
            </Field>
          ) : (
            <Field label="Category" htmlFor="op-category">
              <select id="op-category" className={selectClass} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Choose…</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>{category.name}</option>
                ))}
              </select>
            </Field>
          )}
          <Field label="Location" htmlFor="op-branch">
            <select id="op-branch" className={selectClass} value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((branch) => (
                <option key={branch.id} value={branch.id}>{branch.name}</option>
              ))}
            </select>
          </Field>
          <Field label={`Amount (${currency})`} htmlFor="op-amount">
            <Input id="op-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label="Paid by" htmlFor="op-method">
            <select id="op-method" className={selectClass} value={method} onChange={(e) => setMethod(e.target.value as never)}>
              <option value="BANK_TRANSFER">Bank transfer</option>
              <option value="CHEQUE">Cheque</option>
              <option value="CASH">Cash (needs an open drawer)</option>
              <option value="CARD">Card</option>
              <option value="QR">QR</option>
              <option value="ONLINE">Online</option>
              <option value="WALLET">Wallet</option>
            </select>
          </Field>
          <Field
            label="Pay from"
            htmlFor="op-payfrom"
            hint={accounts.length === 0 ? 'No accounts yet — add them under Payment details.' : undefined}
          >
            <select id="op-payfrom" className={selectClass} value={payFromAccountId} onChange={(e) => setPayFromAccountId(e.target.value)}>
              <option value="">Not specified</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>{account.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Payment date" htmlFor="op-date">
            <Input id="op-date" type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} />
          </Field>
          <Field
            label={method === 'CHEQUE' ? 'Cheque number' : 'Reference'}
            htmlFor="op-ref"
            hint={method === 'CHEQUE' ? 'The number printed on the cheque' : 'Bill number, transfer id…'}
          >
            <Input id="op-ref" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
        <Field label="What is it for?" htmlFor="op-desc">
          <Textarea id="op-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="September rent for the Main branch" />
        </Field>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Not now</Button>
          <Button variant="outline" disabled={pending} onClick={() => submitDraft(false)}>Save draft</Button>
          <Button loading={pending} onClick={() => submitDraft(true)}>
            {selfApproves ? 'Save & approve' : 'Submit for approval'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
