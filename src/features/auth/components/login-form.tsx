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

export function LoginForm({ variant = 'staff' }: { variant?: 'staff' | 'admin' }) {
  const params = useSearchParams()
  const nextPath = params.get('next')
  const staffCode = params.get('staff')
  const [staffName, setStaffName] = React.useState<string | null>(null)
  const [showPassword, setShowPassword] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)
  const isAdmin = variant === 'admin'

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', remember: true },
  })

  /*
   * A staff link carries the person's code. Looking it up fills in their email
   * and greets them by name, so the only thing they type is their password.
   * It is a convenience, never a credential — the lookup returns nothing that
   * grants access, and a failure leaves the ordinary form untouched.
   */
  React.useEffect(() => {
    if (!staffCode) return
    let cancelled = false
    fetch(`/api/staff/lookup?code=${encodeURIComponent(staffCode)}`)
      .then((r) => r.json())
      .then((data) => {
        if (cancelled || !data?.found) return
        setStaffName(data.name)
        form.setValue('email', data.email)
      })
      .catch(() => {
        // Signing in by hand still works.
      })
    return () => { cancelled = true }
  }, [staffCode, form])

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await login(values)

    if (!result.ok) {
      setFormError(result.error)
      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          form.setError(field as keyof LoginInput, { message: messages[0] })
        }
      }
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
          {isAdmin ? 'Platform admin 🛡️' : 'Welcome back 👋'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isAdmin
            ? 'Sign in to review and manage restaurants on your platform.'
            : 'Sign in to continue to your account'}
        </p>
      </header>

      {staffName ? (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm">
          Welcome back, <strong>{staffName}</strong> — enter your password to continue.
        </p>
      ) : null}

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

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
