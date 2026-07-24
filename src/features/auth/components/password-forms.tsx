'use client'

import * as React from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { ArrowLeft, CheckCircle2, Lock, Mail } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { requestPasswordReset, resetPassword } from '../actions'
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  type ForgotPasswordInput,
  type ResetPasswordInput,
} from '../schema'

export function ForgotPasswordForm() {
  const [sent, setSent] = React.useState(false)
  const [formError, setFormError] = React.useState<string | null>(null)

  const form = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  })

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await requestPasswordReset(values)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    setSent(true)
  })

  if (sent) {
    return (
      <div className="space-y-6 text-center">
        <span className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-success/10 text-success">
          <CheckCircle2 className="size-7" />
        </span>
        <div className="space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight">Check your inbox</h1>
          <p className="text-balance text-sm text-muted-foreground">
            If an account exists for <strong>{form.getValues('email')}</strong>, a reset link is on
            its way. It expires in one hour.
          </p>
        </div>
        <Button variant="outline" className="w-full" asChild>
          <Link href="/login">
            <ArrowLeft /> Back to sign in
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Reset your password</h1>
        <p className="text-sm text-muted-foreground">
          Enter your email and we will send you a link to set a new password.
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
            {...form.register('email')}
          />
        </Field>

        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>
          Send reset link
        </Button>
      </form>

      <Link
        href="/login"
        className="flex items-center justify-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Back to sign in
      </Link>
    </div>
  )
}

export function ResetPasswordForm() {
  const router = useRouter()
  const token = useSearchParams().get('token') ?? ''
  const [formError, setFormError] = React.useState<string | null>(null)

  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
    defaultValues: { token, password: '', confirmPassword: '' },
  })

  React.useEffect(() => {
    form.setValue('token', token)
  }, [token, form])

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await resetPassword(values)
    if (!result.ok) {
      setFormError(result.error)
      return
    }
    toast.success('Password updated. Sign in with your new password.')
    router.push('/login')
  })

  if (!token) {
    return (
      <div className="space-y-6">
        <Alert variant="destructive" title="Invalid link">
          This password reset link is missing its token. Request a new one.
        </Alert>
        <Button className="w-full" asChild>
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">Set a new password</h1>
        <p className="text-sm text-muted-foreground">
          Choose a strong password. All other devices will be signed out.
        </p>
      </header>

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <input type="hidden" {...form.register('token')} />

        <Field
          label="New password"
          htmlFor="password"
          required
          error={form.formState.errors.password?.message}
        >
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
          Update password
        </Button>
      </form>
    </div>
  )
}
