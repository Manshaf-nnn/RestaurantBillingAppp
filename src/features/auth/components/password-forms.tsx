'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { ArrowLeft, KeyRound, Lock, Mail, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { callAction } from '@/lib/use-action'
import {
  completePasswordReset,
  requestPasswordResetCode,
  resendPasswordResetCode,
  verifyPasswordResetCode,
} from '../actions'
import {
  forgotPasswordSchema,
  newPasswordSchema,
  resetCodeSchema,
  type ForgotPasswordInput,
  type NewPasswordInput,
  type ResetCodeInput,
} from '../schema'

/**
 * The three screens of forgot-password (prisma/email.md §10).
 *
 * Each is one form that reports what the server said and moves on; none of
 * them holds a secret — the code goes by email, the state goes in httpOnly
 * cookies the server owns. `from` only decides where "Back to sign in" goes.
 */

type From = 'staff' | 'admin'

const signInHref = (from: From) => (from === 'admin' ? '/admin/login' : '/login')
const withFrom = (path: string, from: From) => (from === 'admin' ? `${path}?from=admin` : path)

function BackToSignIn({ from }: { from: From }) {
  return (
    <Link
      href={signInHref(from)}
      className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
    >
      <ArrowLeft className="size-4" /> Back to sign in
    </Link>
  )
}

// ── 1. Enter email ───────────────────────────────────────────────────────────

export function ForgotPasswordForm({ from = 'staff' }: { from?: From }) {
  const router = useRouter()
  const [formError, setFormError] = React.useState<string | null>(null)

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '', from },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await callAction(() => requestPasswordResetCode({ ...values, from }))
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    router.push(withFrom('/forgot-password/verify', from))
  })

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Forgot your password?</h1>
        <p className="text-sm text-muted-foreground">
          Enter the email you signed up with and we will send you a 6-digit code to reset it.
        </p>
      </header>

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email address" htmlFor="email" required error={form.formState.errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="you@restaurant.com"
            startIcon={<Mail />}
            {...form.register('email')}
          />
        </Field>

        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>
          Send reset code
        </Button>
      </form>

      <BackToSignIn from={from} />
    </div>
  )
}

// ── 2. Enter the code ────────────────────────────────────────────────────────

export function VerifyResetCodeForm({
  maskedEmail,
  cooldownSeconds,
  from = 'staff',
}: {
  maskedEmail: string
  /** Seconds until "Resend code" is allowed, as of render. */
  cooldownSeconds: number
  from?: From
}) {
  const router = useRouter()
  const [formError, setFormError] = React.useState<string | null>(null)
  const [dead, setDead] = React.useState(false)
  const [cooldown, setCooldown] = React.useState(cooldownSeconds)
  const [resending, setResending] = React.useState(false)

  React.useEffect(() => {
    if (cooldown <= 0) return
    const timer = setInterval(() => setCooldown((s) => (s > 0 ? s - 1 : 0)), 1000)
    return () => clearInterval(timer)
  }, [cooldown])

  const form = useForm<ResetCodeInput>({
    resolver: zodResolver(resetCodeSchema),
    defaultValues: { code: '' },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await callAction(() => verifyPasswordResetCode(values))
    if (!result.ok) {
      if (result.code === 'RESET_CODE_LOCKED' || result.code === 'RESET_EXPIRED') setDead(true)
      setFormError(result.error)
      return
    }
    router.push(withFrom('/forgot-password/new', from))
  })

  const resend = async () => {
    setResending(true)
    setFormError(null)
    const result = await callAction(() => resendPasswordResetCode())
    setResending(false)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setDead(false)
    form.reset({ code: '' })
    setCooldown(result.data.cooldownSeconds)
    toast.success(result.message ?? 'If an account exists for this email, a new code has been sent.')
  }

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Check your email</h1>
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <strong>{maskedEmail}</strong> if an account exists for it. The
          code expires in 10 minutes.
        </p>
      </header>

      {formError ? (
        <Alert variant="destructive" title={dead ? 'This code no longer works' : undefined}>
          {formError}
        </Alert>
      ) : null}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Reset code" htmlFor="code" required error={form.formState.errors.code?.message}>
          <Input
            id="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="123 456"
            maxLength={7}
            className="font-mono text-lg tracking-[0.3em]"
            startIcon={<KeyRound />}
            disabled={dead}
            {...form.register('code')}
          />
        </Field>

        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting} disabled={dead}>
          Verify code
        </Button>
      </form>

      <div className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
        {cooldown > 0 ? (
          <span>
            Didn&apos;t get it? Resend in <span className="tabular-nums">{cooldown}s</span>
          </span>
        ) : (
          <Button type="button" variant="ghost" size="sm" onClick={resend} loading={resending}>
            <RefreshCw /> {dead ? 'Request a new code' : 'Resend code'}
          </Button>
        )}
      </div>

      <BackToSignIn from={from} />
    </div>
  )
}

// ── 3. New password ──────────────────────────────────────────────────────────

export function NewPasswordForm({ from = 'staff' }: { from?: From }) {
  const router = useRouter()
  const [formError, setFormError] = React.useState<string | null>(null)
  const [expired, setExpired] = React.useState(false)

  const form = useForm<NewPasswordInput>({
    resolver: zodResolver(newPasswordSchema),
    defaultValues: { password: '', confirmPassword: '' },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await callAction(() => completePasswordReset(values))
    if (!result.ok) {
      if (result.code === 'RESET_EXPIRED') setExpired(true)
      setFormError(result.error)
      return
    }
    toast.success('Password reset successfully. Please sign in with your new password.')
    router.push(result.data.redirectTo)
  })

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Create a new password</h1>
        <p className="text-sm text-muted-foreground">
          At least 8 characters with an uppercase letter, a lowercase letter and a number. Every
          device signed in as you will be signed out.
        </p>
      </header>

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      {expired ? (
        <Button className="w-full" asChild>
          <Link href={withFrom('/forgot-password', from)}>Request a new code</Link>
        </Button>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <Field label="New password" htmlFor="password" required error={form.formState.errors.password?.message}>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              startIcon={<Lock />}
              {...form.register('password')}
            />
          </Field>

          <Field
            label="Confirm password"
            htmlFor="confirmPassword"
            required
            error={form.formState.errors.confirmPassword?.message}
          >
            <Input
              id="confirmPassword"
              type="password"
              autoComplete="new-password"
              startIcon={<Lock />}
              {...form.register('confirmPassword')}
            />
          </Field>

          <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>
            Reset password
          </Button>
        </form>
      )}

      <BackToSignIn from={from} />
    </div>
  )
}
