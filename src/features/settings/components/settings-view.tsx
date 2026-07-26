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
import { updatePaymentSettings, updateRestaurantSettings } from '../actions'

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
  serviceChargePercent: number
  loyaltyEnabled: boolean
  loyaltyEarnRate: number
  loyaltyPointValue: number
  payment: { cash: boolean; card: boolean; qr: boolean; online: boolean; upiId: string; payeeName: string }
}

export function SettingsView({ initial, canManage }: { initial: SettingsData; canManage: boolean }) {
  const [form, setForm] = React.useState(initial)
  const [payment, setPayment] = React.useState(initial.payment)
  const [savingProfile, setSavingProfile] = React.useState(false)
  const [savingPayments, setSavingPayments] = React.useState(false)

  const set = <K extends keyof SettingsData>(key: K, value: SettingsData[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const saveProfile = async () => {
    setSavingProfile(true)
    const result = await updateRestaurantSettings(form)
    setSavingProfile(false)
    if (result.ok) toast.success('Settings saved')
    else toast.error(result.error)
  }

  const savePayments = async () => {
    setSavingPayments(true)
    const result = await updatePaymentSettings(payment)
    setSavingPayments(false)
    if (result.ok) toast.success('Payment settings saved')
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
