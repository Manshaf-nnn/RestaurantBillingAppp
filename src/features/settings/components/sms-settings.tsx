'use client'

import * as React from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input, Textarea } from '@/components/ui/input'
import { Switch } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { countSegments, nonGsm7Characters } from '@/features/sms/encoding'
import { LK, toE164, formatForGateway, E164_FAILURE_MESSAGE } from '@/features/sms/msisdn'
import { PRESET_ORDER, SMS_PRESETS } from '@/features/sms/presets'
import type {
  PublicSmsConfig,
  SmsCredentialField,
  SmsProviderKey,
  SmsTriggerKey,
} from '@/features/sms/types'
import { previewSmsRequest, sendTestSms, updateSmsConfig, type SmsRequestPreview } from '../actions'

/**
 * Where a shop owner plugs in the SMS account they already pay for.
 *
 * ── Written for somebody who is not an engineer ─────────────────────────────
 *
 * The person filling this in owns a restaurant. They have their gateway's
 * website open in another tab and they want their guests to get a text. They
 * do not know what a JSON path is and will never need to.
 *
 * So the screen asks THREE things: which company, the codes from that
 * company's website, and a phone number to prove it works. Everything else —
 * limits, cost, number formats, response rules — is real and still here, but
 * folded under "Advanced", because a field that 95% of owners must not touch
 * should not be in front of 100% of them.
 *
 * The two questions that actually cost people days are asked in plain words
 * right where they matter: is the sender name approved, and is this a free
 * trial account. Both fail silently at the gateway — each returns "success"
 * and delivers nothing — so an owner who answers them here never has to
 * discover that over a week of support tickets.
 */

const TRIGGERS: Array<{ key: SmsTriggerKey; label: string; help: string }> = [
  { key: 'receipt', label: 'Send the bill by SMS', help: 'After a guest pays.' },
  { key: 'orderReady', label: 'Tell guests their food is ready', help: 'For takeaway and QR orders.' },
  { key: 'reservationConfirm', label: 'Confirm table bookings', help: 'As soon as a table is booked.' },
  { key: 'reservationReminder', label: 'Remind guests of their booking', help: 'A couple of hours before.' },
  { key: 'otp', label: 'Verify a guest’s phone number', help: 'Sends a code they type back.' },
  { key: 'marketing', label: 'Send offers', help: 'Only to guests who agreed, and must say how to stop.' },
]

export interface SmsSettingsProps {
  initial: PublicSmsConfig
  canManage: boolean
  currency: string
  credentialStoreReady: boolean
}

export function SmsSettings({ initial, canManage, currency, credentialStoreReady }: SmsSettingsProps) {
  const [config, setConfig] = React.useState(initial)
  const [credentials, setCredentials] = React.useState<Partial<Record<SmsCredentialField, string>>>({})
  const [saving, setSaving] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [testTo, setTestTo] = React.useState('')
  const [result, setResult] = React.useState<{ ok: boolean; message: string } | null>(null)
  const [preview, setPreview] = React.useState<SmsRequestPreview | null>(null)

  const preset = SMS_PRESETS[config.provider]
  const working = Boolean(config.verifiedAt)

  const TEST_MESSAGE = 'Test message from your restaurant. If you can read this, SMS is working.'

  /* Runs in the browser, so it updates as they type — no round trip. */
  const dialled = React.useMemo(() => {
    if (!testTo.trim()) return null
    const resolved = toE164(testTo, LK)
    if (!resolved.ok) return { error: E164_FAILURE_MESSAGE[resolved.reason] }
    return {
      value: preset.spec ? formatForGateway(resolved.e164, preset.spec.numberFormat, LK) : resolved.e164,
    }
  }, [testTo, preset])

  const segments = React.useMemo(() => countSegments(TEST_MESSAGE), [])

  const save = async () => {
    setSaving(true)
    const saved = await callAction(() =>
      updateSmsConfig({
        enabled: config.enabled,
        provider: config.provider,
        senderId: config.senderId,
        senderIdApproved: config.senderIdApproved,
        credentials,
        spec: null,
        caps: config.caps,
        cost: config.costMinor === null ? null : config.costMinor / 100,
        costCurrency: config.costCurrency ?? currency,
        triggers: config.triggers,
        templates: config.templates,
        trialOnlyVerified: config.trialOnlyVerified,
        verifiedRecipients: config.verifiedRecipients.join('\n'),
        optOut: config.optOut.join('\n'),
      }),
    )
    setSaving(false)

    if (saved.ok) {
      toast.success('Saved')
      /* Write-only: a blank box means "keep the key you already have". */
      setCredentials({})
    } else {
      toast.error(saved.error)
    }
  }

  const runTest = async () => {
    setTesting(true)
    setResult(null)
    const outcome = await callAction(() => sendTestSms({ to: testTo, message: TEST_MESSAGE }))
    setTesting(false)

    if (!outcome.ok) {
      setResult({ ok: false, message: outcome.error })
      return
    }

    if (outcome.data.sent) {
      setResult({
        ok: true,
        message: `Sent to ${outcome.data.dialled}. Check that phone — it should arrive within a few seconds.`,
      })
      setConfig((prev) => ({ ...prev, verifiedAt: new Date().toISOString() }))
    } else {
      setResult({ ok: false, message: outcome.data.error ?? 'Your gateway did not accept the message.' })
      setConfig((prev) => ({ ...prev, verifiedAt: null }))
    }
  }

  const setTrigger = (key: SmsTriggerKey, value: boolean) =>
    setConfig((prev) => ({ ...prev, triggers: { ...prev.triggers, [key]: value } }))

  return (
    <div className="space-y-4">
      {!credentialStoreReady && (
        <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          This server has no encryption key set, so your API key cannot be stored safely yet. Ask your
          developer to set <code className="mx-0.5">CREDENTIAL_ENCRYPTION_KEY</code> first.
        </p>
      )}

      {/* Where things stand, in one line, in plain words. */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-lg border px-4 py-3 text-sm',
          working ? 'border-emerald-300 bg-emerald-50' : 'border-border bg-muted/40',
        )}
      >
        <span className={cn('font-medium', working && 'text-emerald-800')}>
          {working ? '✓ SMS is working' : 'SMS is not set up yet'}
        </span>
        <span className="text-muted-foreground">
          {working
            ? 'Choose which messages to send, below.'
            : 'Fill in the boxes below, then send yourself a test.'}
        </span>
      </div>

      {/* ── Step 1: the account they already have ───────────────────────── */}
      <SectionCard
        title="1. Your SMS account"
        description="Most shops already have one. Pick the company you pay, then copy the codes from their website."
      >
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {PRESET_ORDER.map((key) => {
            const option = SMS_PRESETS[key]
            const active = config.provider === key
            return (
              <button
                key={key}
                type="button"
                disabled={!canManage}
                onClick={() => setConfig((prev) => ({ ...prev, provider: key as SmsProviderKey }))}
                className={cn(
                  'rounded-lg border p-3 text-left transition',
                  active
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border hover:border-primary/40',
                  !canManage && 'cursor-not-allowed opacity-60',
                )}
              >
                <span className="block text-sm font-medium">{option.label}</span>
                <span className="mt-0.5 block text-xs text-muted-foreground">{option.tagline}</span>
              </button>
            )
          })}
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {preset.credentialFields.map((field) => {
            const stored = config.credentialsPresent.includes(field.name)
            const hint = config.credentialHints[field.name]
            return (
              <Field key={field.name} label={field.label} hint={field.help}>
                <Input
                  type={field.secret ? 'password' : 'text'}
                  autoComplete="off"
                  disabled={!canManage}
                  placeholder={
                    stored
                      ? field.secret
                        ? `Saved (••••${hint ?? ''}) — leave blank to keep it`
                        : (hint ?? '')
                      : (field.example ?? '')
                  }
                  value={credentials[field.name] ?? ''}
                  onChange={(event) =>
                    setCredentials((prev) => ({ ...prev, [field.name]: event.target.value }))
                  }
                />
              </Field>
            )
          })}

          <Field label="Sender name" hint="What guests see the message from. Up to 11 letters.">
            <Input
              disabled={!canManage}
              maxLength={15}
              placeholder="MYSHOP"
              value={config.senderId}
              onChange={(event) => setConfig((prev) => ({ ...prev, senderId: event.target.value }))}
            />
          </Field>
        </div>

        {/*
          The two questions that cost people a week. Both fail silently at the
          gateway, so they are asked here in plain words rather than discovered
          later from an empty inbox.
        */}
        <div className="mt-4 space-y-3 rounded-md bg-muted/40 p-3">
          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={config.senderIdApproved}
              disabled={!canManage}
              onCheckedChange={(value) => setConfig((prev) => ({ ...prev, senderIdApproved: value }))}
            />
            <span>
              My sender name is approved
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Dialog, Mobitel and Hutch each approve it separately, and it takes a few days. Until then
                messages look like they were sent but never arrive.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <Switch
              checked={config.trialOnlyVerified}
              disabled={!canManage}
              onCheckedChange={(value) => setConfig((prev) => ({ ...prev, trialOnlyVerified: value }))}
            />
            <span>
              This is a free trial account
              <span className="mt-0.5 block text-xs text-muted-foreground">
                Trial accounts only text numbers you registered with them, so it works on your phone and
                reaches no guest, with nothing to explain why.
              </span>
            </span>
          </label>

          {config.trialOnlyVerified && (
            <Field label="Numbers registered with your gateway" hint="One per line.">
              <Textarea
                rows={3}
                disabled={!canManage}
                placeholder="0771234567"
                value={config.verifiedRecipients.join('\n')}
                onChange={(event) =>
                  setConfig((prev) => ({ ...prev, verifiedRecipients: event.target.value.split('\n') }))
                }
              />
            </Field>
          )}
        </div>

        <div className="mt-4">
          <Button onClick={save} disabled={!canManage || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </SectionCard>

      {/* ── Step 2: prove it ────────────────────────────────────────────── */}
      <SectionCard
        title="2. Send yourself a test"
        description="Uses one message from your account. Nothing can be switched on until this works."
      >
        <div className="flex flex-wrap items-end gap-3">
          <Field label="Your phone number" className="min-w-[200px] flex-1">
            <Input
              disabled={!canManage}
              value={testTo}
              placeholder="0771234567"
              onChange={(event) => setTestTo(event.target.value)}
            />
          </Field>
          <Button onClick={runTest} disabled={!canManage || testing || !testTo.trim()}>
            {testing ? 'Sending…' : 'Send test message'}
          </Button>
        </div>

        {dialled && 'error' in dialled && <p className="mt-2 text-xs text-destructive">{dialled.error}</p>}
        {dialled && 'value' in dialled && (
          <p className="mt-2 text-xs text-muted-foreground">
            We will dial <code className="font-medium">{dialled.value}</code> &middot;{' '}
            {segments.segments} message{segments.segments > 1 ? 's' : ''} from your balance
          </p>
        )}

        {result && (
          <p
            className={cn(
              'mt-3 rounded-md border px-3 py-2 text-sm',
              result.ok
                ? 'border-emerald-300 bg-emerald-50 text-emerald-900'
                : 'border-destructive/40 bg-destructive/5 text-destructive',
            )}
          >
            {result.ok ? '✓ ' : ''}
            {result.message}
          </p>
        )}
      </SectionCard>

      {/* ── Step 3: what guests receive ─────────────────────────────────── */}
      <SectionCard
        title="3. What to send your guests"
        description={working ? 'Turn on only what you want.' : 'Available once the test above works.'}
      >
        <div className="space-y-3">
          {TRIGGERS.map(({ key, label, help }) => (
            <label key={key} className="flex items-start gap-2 text-sm">
              <Switch
                checked={config.triggers[key]}
                disabled={!canManage || !working}
                onCheckedChange={(value) => setTrigger(key, value)}
              />
              <span>
                {label}
                <span className="mt-0.5 block text-xs text-muted-foreground">{help}</span>
              </span>
            </label>
          ))}
        </div>

        {config.triggers.marketing && (
          <Field
            className="mt-4"
            label="Your offer message"
            hint="Must tell guests how to stop receiving offers."
          >
            <Textarea
              rows={3}
              disabled={!canManage}
              placeholder="10% off this weekend at MYSHOP. Tell our staff to stop these messages."
              value={config.templates.marketing ?? ''}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  templates: { ...prev.templates, marketing: event.target.value },
                }))
              }
            />
          </Field>
        )}

        <div className="mt-4 flex items-center gap-3 border-t pt-4">
          <label className="flex items-center gap-2 text-sm">
            <Switch
              checked={config.enabled}
              disabled={!canManage}
              onCheckedChange={(value) => setConfig((prev) => ({ ...prev, enabled: value }))}
            />
            SMS is on
          </label>
          <Button onClick={save} disabled={!canManage || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </SectionCard>

      {/* ── Folded away: everything most owners never need to open ──────── */}
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          Advanced
          <span className="ml-2 font-normal text-muted-foreground">
            limits, cost, and what we send to your gateway
          </span>
        </summary>

        <div className="space-y-4 border-t px-4 py-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Messages per day" hint="Across the whole restaurant.">
              <Input
                type="number"
                disabled={!canManage}
                value={config.caps.perDay}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    caps: { ...prev.caps, perDay: Number(event.target.value) },
                  }))
                }
              />
            </Field>
            <Field label="Per guest, per day" hint="Stops one guest being spammed.">
              <Input
                type="number"
                disabled={!canManage}
                value={config.caps.perRecipientPerDay}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    caps: { ...prev.caps, perRecipientPerDay: Number(event.target.value) },
                  }))
                }
              />
            </Field>
            <Field
              label={`Cost each (${config.costCurrency ?? currency})`}
              hint="From your gateway's price list."
            >
              <Input
                type="number"
                step="0.01"
                disabled={!canManage}
                value={config.costMinor === null ? '' : config.costMinor / 100}
                onChange={(event) =>
                  setConfig((prev) => ({
                    ...prev,
                    costMinor:
                      event.target.value === '' ? null : Math.round(Number(event.target.value) * 100),
                  }))
                }
              />
            </Field>
          </div>

          <div>
            <Button
              variant="outline"
              disabled={!canManage}
              onClick={async () => {
                const shown = await callAction(() => previewSmsRequest(testTo || '0771234567'))
                if (shown.ok) setPreview(shown.data)
                else toast.error(shown.error)
              }}
            >
              Show what we send to your gateway
            </Button>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Useful if your gateway&apos;s support asks. Your API key is hidden.
            </p>
            {preview && (
              <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">
                {`${preview.method} ${preview.url}\n`}
                {Object.entries(preview.headers)
                  .map(([name, value]) => `${name}: ${value}\n`)
                  .join('')}
                {preview.body ? `\n${preview.body}` : ''}
              </pre>
            )}
          </div>

          {nonGsm7Characters(config.templates.marketing ?? '').length > 0 && (
            <p className="text-xs text-amber-700">
              Your offer message contains {nonGsm7Characters(config.templates.marketing ?? '').join(' ')},
              which makes each message cost more. Sinhala and Tamil always do.
            </p>
          )}

          <Button onClick={save} disabled={!canManage || saving}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </details>
    </div>
  )
}
