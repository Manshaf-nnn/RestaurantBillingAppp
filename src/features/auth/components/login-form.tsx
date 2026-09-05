'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { ArrowRight, Eye, EyeOff, Lock, Mail } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { login } from '../actions'
import { loginSchema, type LoginInput } from '../schema'
import { callAction } from '@/lib/use-action'

export function LoginForm({ variant = 'staff' }: { variant?: 'staff' | 'admin' }) {
  const params = useSearchParams()
  const nextPath = params.get('next')
  // Only ever used to prefill the email box; never trusted for anything else.
  const rawEmail = params.get('email')
  const prefillEmail = rawEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(rawEmail) ? rawEmail : null
  const staffName = params.get('name')
  const [showPassword, setShowPassword] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  /*
   * The second-factor step. The password was right and the account is enrolled,
   * so the server answered `mfaRequired` instead of a session. The form keeps
   * the email and password it already has (react-hook-form retains values of
   * unmounted fields) and resubmits them with the code — the server holds no
   * half-signed-in state, so nothing can be left dangling if the tab is closed.
   */
  const [step, setStep] = React.useState<'credentials' | 'code'>('credentials')
  const isAdmin = variant === 'admin'

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', remember: true },
  })

  /*
   * A staff link carries that person's own email, so the only thing they type
   * is their sign-in code.
   *
   * It used to carry their staff code and look the email up through a public
   * endpoint. Staff codes are a per-restaurant sequence, so anyone could walk
   * W-0001 upward and harvest every email in the restaurant. Putting the address
   * straight in the link tells the recipient only what they already know, and
   * there is no longer an endpoint to walk.
   *
   * Prefilling is a convenience and nothing more — the password is still what
   * authenticates, and a link with someone else's email in it gets no further
   * than the sign-in form.
   */
  React.useEffect(() => {
    if (!prefillEmail) return
    form.setValue('email', prefillEmail)
  }, [prefillEmail, form])

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await callAction(() => login(values))

    if (!result.ok) {
      // A wrong code stays on the code step, with the message on the field —
      // the password is still right and there is no reason to make anyone
      // retype it.
      if (result.code === 'MFA_BAD_CODE') {
        form.setError('code', { message: result.error })
        return
      }
      setFormError(result.error)
      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          form.setError(field as keyof LoginInput, { message: messages[0] })
        }
      }
      return
    }

    if ('mfaRequired' in result.data) {
      form.setValue('code', '')
      setStep('code')
      return
    }

    toast.success('Welcome back')

    // Honor a safe deep-link `next`; otherwise use the server-computed home for
    // this role + approval status. The destination page re-guards regardless.
    const safeNext =
      nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : null
    const target = safeNext ?? result.data.redirectTo

    // Hard navigation guarantees the freshly-set session cookie is sent with the
    // next request (a soft router.push can race cookie propagation).
    window.location.assign(target)
  })

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">
          {step === 'code' ? 'One more step 🔐' : isAdmin ? 'Platform admin 🛡️' : 'Welcome back 👋'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {step === 'code'
            ? 'Enter the six-digit code from your authenticator app.'
            : isAdmin
              ? 'Sign in to review and manage restaurants on your platform.'
              : 'Sign in to continue to your account'}
        </p>
      </header>

      {step === 'credentials' && (staffName || prefillEmail) ? (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          {staffName ? <>Welcome back, <strong>{staffName}</strong> — </> : null}
          enter your sign-in code to continue.
        </p>
      ) : null}

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      {step === 'code' ? (
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          {/*
            Not restricted to digits: a recovery code is XXXXX-XXXXX, and the
            same box takes either. `one-time-code` lets the OS offer a code it
            has just seen in a message.
          */}
          <Field
            label="Authentication code"
            htmlFor="code"
            required
            error={form.formState.errors.code?.message}
          >
            <Input
              id="code"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              autoFocus
              placeholder="123 456"
              startIcon={<Lock />}
              aria-invalid={Boolean(form.formState.errors.code)}
              {...form.register('code')}
            />
          </Field>
          <p className="text-xs text-muted-foreground">
            Lost your phone? Enter one of the recovery codes you saved when you turned this on.
          </p>

          <Button
            type="submit"
            size="lg"
            className="w-full bg-gradient-to-r from-primary to-chart-5 text-primary-foreground shadow-lg shadow-primary/25 hover:opacity-95"
            loading={form.formState.isSubmitting}
          >
            Verify <ArrowRight />
          </Button>

          <button
            type="button"
            onClick={() => {
              form.clearErrors('code')
              form.setValue('code', undefined)
              setStep('credentials')
            }}
            className="block w-full text-center text-sm font-medium text-primary hover:underline"
          >
            Back to sign in
          </button>
        </form>
      ) : (
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email address" htmlFor="email" required error={form.formState.errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="Enter your email"
            startIcon={<Mail />}
            aria-invalid={Boolean(form.formState.errors.email)}
            {...form.register('email')}
          />
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          required
          error={form.formState.errors.password?.message}
        >
          <div className="relative">
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="Enter your password"
              startIcon={<Lock />}
              className="pr-10"
              aria-invalid={Boolean(form.formState.errors.password)}
              {...form.register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((value) => !value)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </Field>

        <div className="flex items-center justify-between text-sm">
          <label className="flex cursor-pointer items-center gap-2 text-muted-foreground">
            <input
              type="checkbox"
              className="size-4 rounded border-input accent-[hsl(var(--primary))]"
              {...form.register('remember')}
            />
            Remember me
          </label>
          <Link href="/forgot-password" className="font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full bg-gradient-to-r from-primary to-chart-5 text-primary-foreground shadow-lg shadow-primary/25 hover:opacity-95"
          loading={form.formState.isSubmitting}
        >
          Sign in <ArrowRight />
        </Button>
      </form>
      )}

      {isAdmin ? (
        <p className="text-center text-sm text-muted-foreground">
          Not the platform admin?{' '}
          <Link href="/login" className="font-medium text-primary hover:underline">
            Restaurant staff sign in
          </Link>
        </p>
      ) : (
        <p className="text-center text-sm text-muted-foreground">
          Don’t have an account?{' '}
          <Link href="/register" className="font-medium text-primary hover:underline">
            Register your restaurant
          </Link>
        </p>
      )}
    </div>
  )
}
