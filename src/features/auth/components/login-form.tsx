'use client'

import * as React from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Eye, EyeOff, Lock, Mail } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { login } from '../actions'
import { loginSchema, type LoginInput } from '../schema'

export function LoginForm() {
  const params = useSearchParams()
  const nextPath = params.get('next')
  const [showPassword, setShowPassword] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '', remember: true },
  })

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

    // The server computes the correct landing from role + approval status.
    // A deep-link `next` only overrides when the server sends us to /dashboard.
    const dest = result.data.redirectTo
    const safeNext =
      nextPath && nextPath.startsWith('/') && !nextPath.startsWith('//') ? nextPath : null
    const target = dest === '/dashboard' && safeNext ? safeNext : dest

    // Hard navigation guarantees the freshly-set session cookie is sent with the
    // next request (a soft router.push can race cookie propagation).
    window.location.assign(target)
  })

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Sign in</h1>
        <p className="text-sm text-muted-foreground">
          Welcome back. Enter your details to reach your dashboard.
        </p>
      </header>

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <Field label="Email" htmlFor="email" required error={form.formState.errors.email?.message}>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@restaurant.com"
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
              placeholder="••••••••"
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
            Keep me signed in
          </label>
          <Link href="/forgot-password" className="font-medium text-primary hover:underline">
            Forgot password?
          </Link>
        </div>

        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>
          Sign in
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        New to RestaurantOS?{' '}
        <Link href="/register" className="font-medium text-primary hover:underline">
          Create your restaurant
        </Link>
      </p>
    </div>
  )
}
