'use client'

import * as React from 'react'
import { KeyRound, ShieldCheck, ShieldOff } from 'lucide-react'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { useAction } from '@/lib/use-action'
import {
  confirmMfaEnrolment,
  disableMfa,
  startMfaEnrolment,
  type EnrolmentStart,
} from '../security-actions'

/**
 * "Two-factor authentication" for the signed-in super admin (athu.md).
 *
 * Three states, one card:
 *
 *   off       → a button that starts enrolment
 *   enrolling → the QR (and the secret, for apps that cannot scan), a code
 *               box, and on success the recovery codes — shown ONCE
 *   on        → a code box that turns it off
 *
 * The recovery codes live in component state only: refresh the page and they
 * are gone, as the server never stored them either. That is the point, and the
 * card says so before it shows them.
 */
export function MfaCard({ enabled, enabledAt }: { enabled: boolean; enabledAt: string | null }) {
  const [enrolment, setEnrolment] = React.useState<EnrolmentStart | null>(null)
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[] | null>(null)
  const [code, setCode] = React.useState('')
  const [codeError, setCodeError] = React.useState<string | null>(null)
  const { busy, run } = useAction()

  const begin = () =>
    run(() => startMfaEnrolment(), {
      onDone: (data) => {
        setEnrolment(data)
        setCode('')
        setCodeError(null)
      },
    })

  const confirm = () =>
    run(() => confirmMfaEnrolment({ code }), {
      onFail: (result) => setCodeError(result.error),
      onDone: (data) => {
        setRecoveryCodes(data.recoveryCodes)
        setEnrolment(null)
        setCode('')
      },
    })

  const disable = () =>
    run(() => disableMfa({ code }), {
      success: 'Two-factor authentication is off.',
      onFail: (result) => setCodeError(result.error),
      onDone: () => setCode(''),
    })

  const codeField = (
    <Field label="Code from your app" htmlFor="mfa-code" error={codeError ?? undefined}>
      <Input
        id="mfa-code"
        inputMode="numeric"
        autoComplete="one-time-code"
        placeholder="123 456"
        value={code}
        onChange={(event) => {
          setCode(event.target.value)
          setCodeError(null)
        }}
        startIcon={<KeyRound />}
        aria-invalid={Boolean(codeError)}
      />
    </Field>
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {enabled ? <ShieldCheck className="size-5 text-emerald-600" /> : <ShieldOff className="size-5 text-muted-foreground" />}
          Two-factor authentication
        </CardTitle>
        <CardDescription>
          {enabled
            ? `On for your account since ${enabledAt ? new Date(enabledAt).toLocaleDateString() : 'today'}. Every sign-in asks for a code from your authenticator app.`
            : 'Your account signs in with a password alone. Add an authenticator app so a stolen password is not enough.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {recoveryCodes ? (
          <div className="space-y-3">
            <Alert variant="warning">
              Save these recovery codes now. Each works once, and they will not be shown again —
              not here, not anywhere. They are how you get in if you lose your phone.
            </Alert>
            <ul className="grid grid-cols-2 gap-2 rounded-lg border border-border bg-muted/40 p-3 font-mono text-sm sm:grid-cols-5">
              {recoveryCodes.map((item) => (
                <li key={item} className="select-all">{item}</li>
              ))}
            </ul>
            <Button variant="outline" onClick={() => setRecoveryCodes(null)}>
              I have saved them
            </Button>
          </div>
        ) : enrolment ? (
          <div className="space-y-4">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
              {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL, nothing to optimise */}
              <img
                src={enrolment.qrDataUrl}
                alt="QR code for your authenticator app"
                width={224}
                height={224}
                className="rounded-lg border border-border bg-white p-2"
              />
              <div className="space-y-2 text-sm">
                <p>Scan this with Google Authenticator, 1Password, Authy or any TOTP app.</p>
                <p className="text-muted-foreground">
                  Cannot scan? Enter this key by hand:
                </p>
                <code className="block select-all break-all rounded-md bg-muted px-2 py-1 font-mono text-xs">
                  {enrolment.secret}
                </code>
              </div>
            </div>
            {codeField}
            <div className="flex gap-2">
              <Button onClick={confirm} loading={busy} disabled={code.trim().length < 6}>
                Turn on
              </Button>
              <Button variant="ghost" onClick={() => setEnrolment(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        ) : enabled ? (
          <div className="space-y-4">
            {codeField}
            <Button variant="destructive" onClick={disable} loading={busy} disabled={code.trim().length < 6}>
              Turn off
            </Button>
          </div>
        ) : (
          <Button onClick={begin} loading={busy}>
            Set up an authenticator app
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
