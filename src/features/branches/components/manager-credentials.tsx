'use client'

import * as React from 'react'
import { Check, Copy } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'

/**
 * The card you hand a new manager.
 *
 * Shown after creating a location with a new manager, and again on that
 * location's own page, so there is one way this information looks rather than
 * two that drift apart.
 *
 * The sign-in code is shown in plain text on purpose, and that is a decision
 * this codebase already made deliberately for staff codes: the owner has to be
 * able to reprint a card someone left on a bus. Hiding it behind a reveal would
 * only mean it gets written on a Post-it instead. It stays readable afterwards
 * on the location page and on /dashboard/staff/codes, and can be replaced at
 * any time with New code.
 *
 * The link matters as much as the code. It carries the manager's own email and
 * a next destination, so the only thing they ever type is eight characters —
 * the same shape /dashboard/staff/codes has used since staff sign-in was built.
 */
export function ManagerCredentials({
  name,
  email,
  signInCode,
  emailed,
  locationName,
  className,
}: {
  name: string
  email: string
  signInCode: string
  /** True when SMTP is configured and the invite actually went out. */
  emailed?: boolean
  locationName?: string
  className?: string
}) {
  /*
   * Built in the browser rather than passed in, because the server does not
   * reliably know the host the owner is actually looking at — behind Netlify's
   * proxy `appUrl()` is an env var that can lag a domain change, and a sign-in
   * link that points at the wrong hostname is worse than no link.
   */
  const [origin, setOrigin] = React.useState('')
  React.useEffect(() => setOrigin(window.location.origin), [])

  const link = origin
    ? `${origin}/login?email=${encodeURIComponent(email)}&name=${encodeURIComponent(
        name.split(' ')[0] ?? name,
      )}&next=${encodeURIComponent('/dashboard')}`
    : ''

  return (
    <div className={className}>
      <Alert
        variant={emailed ? 'success' : 'warning'}
        title={emailed ? 'Sign-in details emailed' : 'Share these details securely'}
      >
        {emailed
          ? `${name} has been emailed their sign-in details${
              locationName ? ` for ${locationName}` : ''
            }. The code below is the same one, and stays here if they lose it.`
          : 'Email is not set up on this deployment, so nothing was sent. Give these to them yourself — a message, a printed card, or read it out.'}
      </Alert>

      <dl className="mt-3 space-y-2">
        <CopyRow label="Signs in with" value={email} />
        <CopyRow label="Sign-in code" value={signInCode} mono />
        {link ? <CopyRow label="Their link" value={link} truncate /> : null}
      </dl>

      <p className="mt-3 border-l-2 border-border pl-3 text-xs leading-relaxed text-muted-foreground">
        They sign in with that email and code — nothing else to remember. The link fills the email
        in for them. You can print or replace the code later from this location&apos;s page or from
        Staff → Sign-in codes.
      </p>
    </div>
  )
}

function CopyRow({
  label,
  value,
  mono,
  truncate,
}: {
  label: string
  value: string
  mono?: boolean
  truncate?: boolean
}) {
  const [copied, setCopied] = React.useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      toast.success(`${label} copied`)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // Clipboard access is refused over plain http and in some embedded
      // browsers. Saying so beats a button that silently does nothing.
      toast.error('Could not copy — select the text and copy it by hand')
    }
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <dt className="w-28 shrink-0 text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd
        className={`min-w-0 flex-1 text-sm ${mono ? 'font-mono tracking-wider' : ''} ${
          truncate ? 'truncate' : 'break-all'
        }`}
      >
        {value}
      </dd>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={copy}
        aria-label={`Copy ${label.toLowerCase()}`}
      >
        {copied ? <Check className="text-emerald-600 dark:text-emerald-400" /> : <Copy />}
      </Button>
    </div>
  )
}
