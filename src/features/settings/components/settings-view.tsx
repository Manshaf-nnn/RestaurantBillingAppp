'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { ImageUpload } from '@/components/image-upload'
import { Switch, Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PageHeader, SectionCard } from '@/features/dashboard/components/page-header'
import { cn } from '@/lib/utils'
import {
  updateCashControls,
  updatePaymentSettings,
  updatePrinterSettings,
  updateLiveBoardPolicy,
  updateRestaurantSettings,
} from '../actions'
import type { LiveBoardPolicy } from '@/features/live/policy'
import { callAction } from '@/lib/use-action'

const CURRENCIES = ['INR', 'USD', 'EUR', 'GBP', 'AED', 'SGD', 'LKR', 'AUD', 'CAD', 'JPY']
const TIMEZONES = [
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Colombo',
  'Asia/Singapore',
  'Europe/London',
  'America/New_York',
  'America/Los_Angeles',
  'Australia/Sydney',
]

export interface SettingsData {
  name: string
  tagline: string
  description: string
  logoUrl: string
  coverUrl: string
  email: string
  phone: string
  addressLine: string
  city: string
  state: string
  postalCode: string
  currency: string
  timezone: string
  taxLabel: string
  taxRatePercent: number
  taxInclusive: boolean
  allowNegativeStock: boolean
  serviceChargePercent: number
  loyaltyEnabled: boolean
  loyaltyEarnRate: number
  loyaltyPointValue: number
  payment: {
    cash: boolean
    card: boolean
    qr: boolean
    online: boolean
    upiId: string
    payeeName: string
    bankTransfer: boolean
    bankName: string
    accountName: string
    accountNumber: string
    bankBranch: string
    receiptWhatsapp: string
  }
  printer: {
    receiptWidth: 58 | 80
    kitchenWidth: 58 | 80
  }
  /** Thresholds in MAJOR units — what the owner would say out loud. */
  cash: {
    cashVarianceAbove: number
    pettyCashApprovalAbove: number
    requireCashierSession: boolean
  }
  /** The live floor board's thresholds. Spend is in whole currency here. */
  live: LiveBoardPolicy
}

export function SettingsView({ initial, canManage }: { initial: SettingsData; canManage: boolean }) {
  const [form, setForm] = React.useState(initial)
  const [payment, setPayment] = React.useState(initial.payment)
  const [savingProfile, setSavingProfile] = React.useState(false)
  const [savingPayments, setSavingPayments] = React.useState(false)
  const [printer, setPrinter] = React.useState(initial.printer)
  const [savingPrinter, setSavingPrinter] = React.useState(false)
  const [cash, setCash] = React.useState(initial.cash)
  const [savingCash, setSavingCash] = React.useState(false)
  const [live, setLive] = React.useState(initial.live)
  const [savingLive, setSavingLive] = React.useState(false)

  const set = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const saveProfile = async () => {
    setSavingProfile(true)
    const result = await callAction(() => updateRestaurantSettings(form))
    setSavingProfile(false)
    if (result.ok) toast.success('Settings saved')
    else toast.error(result.error)
  }

  const savePayments = async () => {
    setSavingPayments(true)
    const result = await callAction(() => updatePaymentSettings(payment))
    setSavingPayments(false)
    if (result.ok) toast.success('Payment settings saved')
    else toast.error(result.error)
  }

  const saveLive = async () => {
    setSavingLive(true)
    const result = await callAction(() => updateLiveBoardPolicy(live))
    setSavingLive(false)
    if (result.ok) toast.success('Live floor settings saved')
    else toast.error(result.error)
  }

  const savePrinter = async () => {
    setSavingPrinter(true)
    const result = await callAction(() => updatePrinterSettings(printer))
    setSavingPrinter(false)
    if (result.ok) toast.success('Printer settings saved')
    else toast.error(result.error)
  }

  const saveCash = async () => {
    setSavingCash(true)
    const result = await callAction(() => updateCashControls(cash))
    setSavingCash(false)
    if (result.ok) toast.success('Cash controls saved')
    else toast.error(result.error)
  }

  return (
    <>
      <PageHeader title="Settings" description="Your restaurant profile, tax, payments and loyalty" />

      <Tabs defaultValue="profile">
        <TabsList>
          <TabsTrigger value="profile">Profile</TabsTrigger>
          <TabsTrigger value="billing">Tax & charges</TabsTrigger>
          <TabsTrigger value="payments">Payments</TabsTrigger>
          <TabsTrigger value="loyalty">Loyalty</TabsTrigger>
          <TabsTrigger value="printer">Printer</TabsTrigger>
          <TabsTrigger value="cash">Cash controls</TabsTrigger>
          <TabsTrigger value="live">Live floor</TabsTrigger>
        </TabsList>

        <TabsContent value="profile" className="space-y-4">
          <SectionCard title="Restaurant details">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" required className="sm:col-span-2">
                <Input value={form.name} onChange={(e) => set('name', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Tagline" className="sm:col-span-2">
                <Input value={form.tagline} onChange={(e) => set('tagline', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Description" className="sm:col-span-2">
                <Textarea value={form.description} onChange={(e) => set('description', e.target.value)} rows={2} disabled={!canManage} />
              </Field>
              <Field label="Logo">
                <ImageUpload value={form.logoUrl} onChange={(url) => set('logoUrl', url)} aspect="square" />
              </Field>
              <Field label="Cover image">
                <ImageUpload value={form.coverUrl} onChange={(url) => set('coverUrl', url)} />
              </Field>
              <Field label="Email">
                <Input type="email" value={form.email} onChange={(e) => set('email', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Phone">
                <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Address" className="sm:col-span-2">
                <Input value={form.addressLine} onChange={(e) => set('addressLine', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="City">
                <Input value={form.city} onChange={(e) => set('city', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Postal code">
                <Input value={form.postalCode} onChange={(e) => set('postalCode', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Currency">
                <Select value={form.currency} onValueChange={(v) => set('currency', v)} disabled={!canManage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CURRENCIES.map((currency) => (
                      <SelectItem key={currency} value={currency}>
                        {currency}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Timezone">
                <Select value={form.timezone} onValueChange={(v) => set('timezone', v)} disabled={!canManage}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
          </SectionCard>
          {canManage ? (
            <Button onClick={saveProfile} loading={savingProfile}>
              Save profile
            </Button>
          ) : null}
        </TabsContent>

        <TabsContent value="billing" className="space-y-4">
          <SectionCard title="Tax & service charge">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Tax label" hint="e.g. GST, VAT, Sales tax">
                <Input value={form.taxLabel} onChange={(e) => set('taxLabel', e.target.value)} disabled={!canManage} />
              </Field>
              <Field label="Tax rate (%)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.taxRatePercent}
                  onChange={(e) => set('taxRatePercent', Number(e.target.value))}
                  disabled={!canManage}
                />
              </Field>
              <Field label="Service charge (%)">
                <Input
                  type="number"
                  step="0.01"
                  value={form.serviceChargePercent}
                  onChange={(e) => set('serviceChargePercent', Number(e.target.value))}
                  disabled={!canManage}
                />
              </Field>
              <label className="flex items-center gap-2 self-end pb-2 text-sm">
                <Switch checked={form.taxInclusive} onCheckedChange={(v) => set('taxInclusive', v)} disabled={!canManage} />
                Prices include tax
              </label>
            </div>

            <div className="mt-4 rounded-lg border border-border p-3">
              <label className="flex items-start gap-3 text-sm">
                <Switch
                  checked={form.allowNegativeStock}
                  onCheckedChange={(v) => set('allowNegativeStock', v)}
                  disabled={!canManage}
                />
                <span>
                  <span className="font-medium">Allow selling stock you have run out of</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    Off: the till refuses an item once its stock reaches zero, so the figures stay
                    true. On: service is never blocked and the balance goes negative until the
                    delivery is keyed in. Corrections and stock counts are always allowed either way.
                  </span>
                </span>
              </label>
            </div>
          </SectionCard>
          {canManage ? (
            <Button onClick={saveProfile} loading={savingProfile}>
              Save tax settings
            </Button>
          ) : null}
        </TabsContent>

        <TabsContent value="payments" className="space-y-4">
          <SectionCard title="Accepted payment methods">
            <div className="space-y-3">
              <PaymentToggle label="Cash" checked={payment.cash} onChange={(v) => setPayment({ ...payment, cash: v })} disabled={!canManage} />
              <PaymentToggle label="Card" checked={payment.card} onChange={(v) => setPayment({ ...payment, card: v })} disabled={!canManage} />
              <PaymentToggle label="QR / UPI" checked={payment.qr} onChange={(v) => setPayment({ ...payment, qr: v })} disabled={!canManage} />
              <PaymentToggle label="Online gateway" checked={payment.online} onChange={(v) => setPayment({ ...payment, online: v })} disabled={!canManage} />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="UPI ID" hint="For dynamic payment QR (India)">
                <Input value={payment.upiId} onChange={(e) => setPayment({ ...payment, upiId: e.target.value })} disabled={!canManage} placeholder="name@bank" />
              </Field>
              <Field label="Payee name">
                <Input value={payment.payeeName} onChange={(e) => setPayment({ ...payment, payeeName: e.target.value })} disabled={!canManage} />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Online / bank transfer">
            <p className="text-sm text-muted-foreground">
              Show your bank account to guests so they can transfer the bill directly, then send you
              the receipt on WhatsApp. Great where card machines aren&rsquo;t used.
            </p>
            <div className="mt-4">
              <PaymentToggle
                label="Accept online bank transfer"
                checked={payment.bankTransfer}
                onChange={(v) => setPayment({ ...payment, bankTransfer: v })}
                disabled={!canManage}
              />
            </div>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Bank name">
                <Input value={payment.bankName} onChange={(e) => setPayment({ ...payment, bankName: e.target.value })} disabled={!canManage || !payment.bankTransfer} placeholder="e.g. Commercial Bank" />
              </Field>
              <Field label="Account holder name">
                <Input value={payment.accountName} onChange={(e) => setPayment({ ...payment, accountName: e.target.value })} disabled={!canManage || !payment.bankTransfer} />
              </Field>
              <Field label="Account number">
                <Input value={payment.accountNumber} onChange={(e) => setPayment({ ...payment, accountNumber: e.target.value })} disabled={!canManage || !payment.bankTransfer} />
              </Field>
              <Field label="Branch">
                <Input value={payment.bankBranch} onChange={(e) => setPayment({ ...payment, bankBranch: e.target.value })} disabled={!canManage || !payment.bankTransfer} />
              </Field>
              <Field label="Receipt WhatsApp number" hint="Guests send their transfer slip here" className="sm:col-span-2">
                <Input value={payment.receiptWhatsapp} onChange={(e) => setPayment({ ...payment, receiptWhatsapp: e.target.value })} disabled={!canManage || !payment.bankTransfer} placeholder="+94 7X XXX XXXX" />
              </Field>
            </div>
          </SectionCard>

          {canManage ? (
            <Button onClick={savePayments} loading={savingPayments}>
              Save payment settings
            </Button>
          ) : null}
        </TabsContent>

        <TabsContent value="loyalty" className="space-y-4">
          <SectionCard title="Loyalty programme">
            <p className="text-sm text-muted-foreground">
              Reward guests with points on every order that they can redeem for money off future
              visits. Guests see this on the ordering page after they scan your QR.
            </p>
            <label className="mt-4 flex items-center gap-2 text-sm">
              <Switch checked={form.loyaltyEnabled} onCheckedChange={(v) => set('loyaltyEnabled', v)} disabled={!canManage} />
              Enable loyalty points
            </label>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label={`Points earned per 1 ${form.currency} spent`} hint="e.g. 1 point for every ₹1 on the bill">
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  value={form.loyaltyEarnRate}
                  onChange={(e) => set('loyaltyEarnRate', Number(e.target.value))}
                  disabled={!canManage || !form.loyaltyEnabled}
                />
              </Field>
              <Field label={`Value of 1 point (in ${form.currency})`} hint="e.g. 0.10 means 10 points = ₹1 off">
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.loyaltyPointValue}
                  onChange={(e) => set('loyaltyPointValue', Number(e.target.value))}
                  disabled={!canManage || !form.loyaltyEnabled}
                />
              </Field>
            </div>

            {form.loyaltyEnabled ? (
              <p className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                Example: a {form.currency} 1,000 order earns{' '}
                <strong className="text-foreground">
                  {Math.round(1000 * (form.loyaltyEarnRate || 0)).toLocaleString()} points
                </strong>
                {form.loyaltyPointValue > 0 ? (
                  <>
                    {' '}— worth about{' '}
                    <strong className="text-foreground">
                      {form.currency}{' '}
                      {Math.round(1000 * (form.loyaltyEarnRate || 0) * form.loyaltyPointValue).toLocaleString()}
                    </strong>{' '}
                    off a future visit.
                  </>
                ) : (
                  '.'
                )}
              </p>
            ) : null}
          </SectionCard>
          {canManage ? (
            <Button onClick={saveProfile} loading={savingProfile}>
              Save loyalty settings
            </Button>
          ) : null}
        </TabsContent>

        <TabsContent value="printer" className="space-y-4">
          <SectionCard title="Receipt printer">
            <p className="mb-4 text-sm text-muted-foreground">
              Choose the paper your thermal printer is loaded with. This sets the page
              size and text scale of everything you print, so getting it wrong either
              wastes a third of the roll or overflows it.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Customer receipts" hint="Bills printed from the cashier screen">
                <PaperChoice
                  value={printer.receiptWidth}
                  disabled={!canManage}
                  onChange={(receiptWidth) => setPrinter((c) => ({ ...c, receiptWidth }))}
                />
              </Field>
              <Field label="Kitchen tickets" hint="Order tickets printed from the kitchen display">
                <PaperChoice
                  value={printer.kitchenWidth}
                  disabled={!canManage}
                  onChange={(kitchenWidth) => setPrinter((c) => ({ ...c, kitchenWidth }))}
                />
              </Field>
            </div>

            <p className="mt-4 rounded-lg bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              Any printer your computer or tablet can already print to will work — connect
              it over USB, network or Bluetooth and install its driver, then it appears in
              the print dialog. No extra setup is needed here.
            </p>
          </SectionCard>

          {canManage ? (
            <Button onClick={savePrinter} loading={savingPrinter}>
              Save printer settings
            </Button>
          ) : null}
        </TabsContent>

        <TabsContent value="live" className="space-y-4">
          <SectionCard title="How long is too long">
            <p className="mb-4 text-sm text-muted-foreground">
              Minutes from when an order reaches the kitchen. Each band has to be
              longer than the one before it, or a rung of the ladder can never be
              reached.
            </p>
            <div className="grid gap-4 sm:grid-cols-4">
              {([
                ['normalMax', 'Normal up to'],
                ['watchMax', 'Watch up to'],
                ['attentionMax', 'Attention up to'],
                ['delayedMax', 'Delayed up to'],
              ] as const).map(([key, label]) => (
                <Field key={key} label={label}>
                  <Input
                    inputMode="numeric"
                    value={String(live[key])}
                    disabled={!canManage}
                    onChange={(e) => setLive((v) => ({ ...v, [key]: Number(e.target.value) || 0 }))}
                  />
                </Field>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Anything past the last one is critical.
            </p>
          </SectionCard>

          <SectionCard title="When to go and look">
            <div className="grid gap-4 sm:grid-cols-2">
              {([
                ['noFoodServedMin', 'Nothing served after', 'Minutes with no food out at all.'],
                ['readyNotServedMin', 'Ready but not taken out', 'Food sitting under the lamp.'],
                ['stuckPreparingMin', 'Still preparing after', 'Measured from when the kitchen started.'],
                ['paymentPendingMin', 'Bill unpaid after serving', 'Everything out, nobody has paid.'],
                ['sensitiveWaitingMin', 'A guest worth greeting waits', 'First visit, VIP, or back after a long gap.'],
                ['longServiceMin', 'A sitting runs longer than', 'The whole visit, not the wait for food.'],
                ['serviceRequestMin', 'A call for service goes unanswered', 'Minutes since they asked.'],
                ['lowProgressPct', 'Barely served, below', 'A percentage. Flags a late table that has had almost nothing.'],
              ] as const).map(([key, label, hint]) => (
                <Field key={key} label={label} hint={hint}>
                  <Input
                    inputMode="numeric"
                    value={String(live[key])}
                    disabled={!canManage}
                    onChange={(e) => setLive((v) => ({ ...v, [key]: Number(e.target.value) || 0 }))}
                  />
                </Field>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Who counts as a regular">
            <p className="mb-4 text-sm text-muted-foreground">
              Counted from completed visits only — an order in progress is not a
              visit yet, and a cancelled one never was.
            </p>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Regular after" hint="Completed visits.">
                <Input
                  inputMode="numeric"
                  value={String(live.regularAfterVisits)}
                  disabled={!canManage}
                  onChange={(e) => setLive((v) => ({ ...v, regularAfterVisits: Number(e.target.value) || 0 }))}
                />
              </Field>
              <Field label="VIP after" hint="Completed visits. Must be more than regular.">
                <Input
                  inputMode="numeric"
                  value={String(live.vipAfterVisits)}
                  disabled={!canManage}
                  onChange={(e) => setLive((v) => ({ ...v, vipAfterVisits: Number(e.target.value) || 0 }))}
                />
              </Field>
              <Field label="…or having spent" hint="Lifetime, in whole currency. 0 turns this route off.">
                <Input
                  inputMode="decimal"
                  value={String(live.vipAfterSpend)}
                  disabled={!canManage}
                  onChange={(e) => setLive((v) => ({ ...v, vipAfterSpend: Number(e.target.value) || 0 }))}
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Coming back after a while">
            <p className="mb-4 text-sm text-muted-foreground">
              Days since their last completed visit. These sit alongside the status
              above rather than replacing it — a regular who has been away four
              months is both.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Welcome back after" hint="Days away.">
                <Input
                  inputMode="numeric"
                  value={String(live.welcomeBackDays)}
                  disabled={!canManage}
                  onChange={(e) => setLive((v) => ({ ...v, welcomeBackDays: Number(e.target.value) || 0 }))}
                />
              </Field>
              <Field label="Worth making a fuss of after" hint="Days away. Must be longer than the above.">
                <Input
                  inputMode="numeric"
                  value={String(live.longTimeReturnDays)}
                  disabled={!canManage}
                  onChange={(e) => setLive((v) => ({ ...v, longTimeReturnDays: Number(e.target.value) || 0 }))}
                />
              </Field>
            </div>
          </SectionCard>

          {canManage ? (
            <Button onClick={saveLive} loading={savingLive}>Save live floor settings</Button>
          ) : null}
        </TabsContent>

        <TabsContent value="cash" className="space-y-4">
          <SectionCard title="When a second pair of eyes is needed">
            <p className="mb-4 text-sm text-muted-foreground">
              Set these to the amounts you would actually want to be told about. A
              threshold everybody trips over every night stops being a control and
              becomes a step people learn to click through.
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field
                label="Drawer variance to review"
                hint="A till counted this far from expected waits for a manager to sign it off. 0 turns it off."
              >
                <Input
                  inputMode="decimal"
                  value={String(cash.cashVarianceAbove)}
                  disabled={!canManage}
                  onChange={(e) =>
                    setCash((c) => ({ ...c, cashVarianceAbove: Number(e.target.value) || 0 }))
                  }
                />
              </Field>
              <Field
                label="Petty cash needing another approver"
                hint="At or above this, the person who asked cannot be the person who approves. 0 turns it off."
              >
                <Input
                  inputMode="decimal"
                  value={String(cash.pettyCashApprovalAbove)}
                  disabled={!canManage}
                  onChange={(e) =>
                    setCash((c) => ({
                      ...c,
                      pettyCashApprovalAbove: Number(e.target.value) || 0,
                    }))
                  }
                />
              </Field>
            </div>
          </SectionCard>

          <SectionCard title="Starting a shift">
            <label className="flex items-start gap-3 text-sm">
              <input
                type="checkbox"
                className="mt-1 size-4"
                checked={cash.requireCashierSession}
                disabled={!canManage}
                onChange={(e) =>
                  setCash((c) => ({ ...c, requireCashierSession: e.target.checked }))
                }
              />
              <span>
                <span className="font-medium">
                  Cashiers must open a drawer before they can work
                </span>
                <span className="mt-1 block text-muted-foreground">
                  Cash taken with no drawer open belongs to no shift and can never be
                  counted against anything. Leave this on unless your staff genuinely
                  handle no cash — managers and owners are never stopped by it either
                  way.
                </span>
              </span>
            </label>
          </SectionCard>

          {canManage ? (
            <Button onClick={saveCash} loading={savingCash}>
              Save cash controls
            </Button>
          ) : null}
        </TabsContent>
      </Tabs>
    </>
  )
}

function PaymentToggle({
  label,
  checked,
  onChange,
  disabled,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <label className="flex items-center justify-between rounded-lg border px-4 py-3">
      <span className="text-sm font-medium">{label}</span>
      <Switch checked={checked} onCheckedChange={onChange} disabled={disabled} />
    </label>
  )
}

/** 58 mm / 80 mm picker — the two standard thermal roll sizes. */
function PaperChoice({
  value,
  onChange,
  disabled,
}: {
  value: 58 | 80
  onChange: (value: 58 | 80) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex rounded-lg border bg-muted/40 p-1">
      {([58, 80] as const).map((width) => (
        <button
          key={width}
          type="button"
          disabled={disabled}
          onClick={() => onChange(width)}
          className={cn(
            'rounded-md px-4 py-1.5 text-sm font-medium transition-colors disabled:opacity-50',
            value === width ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
          )}
        >
          {width} mm
        </button>
      ))}
    </div>
  )
}
