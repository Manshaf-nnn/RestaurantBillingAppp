'use client'

import * as React from 'react'
import { ArrowRight, Monitor } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

import { joinAsDevice, joinWithCode } from '../join-actions'

/**
 * The two ways in.
 *
 * Both actions end in `redirect()`, which throws a navigation signal rather
 * than returning. `callAction` would swallow it, so these are called directly
 * and the failure path is handled by hand — the opt-out `no-raw-action-calls`
 * provides for exactly this case.
 */
export function JoinForm({
  token,
  mode,
  email: initialEmail,
}: {
  token: string
  mode: 'PERSONAL' | 'SHARED_DEVICE'
  email: string | null
}) {
  const [email, setEmail] = React.useState(initialEmail ?? '')
  const [code, setCode] = React.useState('')
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event?: React.FormEvent) {
    event?.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // action-redirects — these navigate on success and never return.
      const result =
        mode === 'PERSONAL'
          ? await joinWithCode({ token, email, code })
          : await joinAsDevice({ token })
      // Only reached when the action refused; a success has already navigated.
      if (!result.ok) setError(result.error)
    } catch (thrown) {
      /*
       * A redirect is thrown, and rethrowing it is what lets the navigation
       * happen. Anything else is a real transport failure — an expired
       * session, a dropped connection — and has to clear `busy`, or the button
       * says "Signing in…" for ever.
       */
      const digest = (thrown as { digest?: string })?.digest
      if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT')) throw thrown
      setError('Something went wrong. Check your connection and try again.')
    }
    setBusy(false)
  }

  if (mode === 'SHARED_DEVICE') {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <p className="flex items-center gap-2 font-medium text-foreground">
            <Monitor className="size-4" /> Shared screen
          </p>
          <p className="mt-1.5">
            This device stays signed in. Anyone using it works under this role, so keep the link
            off personal phones.
          </p>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <Button className="w-full" onClick={() => submit()} disabled={busy}>
          {busy ? 'Signing in…' : <>Open this screen <ArrowRight /></>}
        </Button>
      </div>
    )
  }

  return (
    <form className="space-y-4" onSubmit={submit}>
      <div className="space-y-1.5">
        <Label htmlFor="join-email">Email</Label>
        <Input
          id="join-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="join-code">Login code</Label>
        <Input
          id="join-code"
          // Not type="password": it is printed on a card, and hiding it while
          // somebody copies it from their hand only causes typing mistakes.
          autoComplete="one-time-code"
          autoCapitalize="characters"
          spellCheck={false}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder="XXXX-XXXX"
          className="font-mono tracking-wider"
          required
        />
        <p className="text-xs text-muted-foreground">
          The code on your card. Upper or lower case, with or without the dash.
        </p>
      </div>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <Button type="submit" className="w-full" disabled={busy || !email || !code}>
        {busy ? 'Signing in…' : <>Sign in <ArrowRight /></>}
      </Button>
    </form>
  )
}
