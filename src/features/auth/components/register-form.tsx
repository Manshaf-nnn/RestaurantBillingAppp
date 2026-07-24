'use client'

import * as React from 'react'
import Link from 'next/link'
import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { Building2, Lock, Mail, Phone, User } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/primitives'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { register as registerAction } from '../actions'
import { registerSchema, type RegisterInput } from '../schema'

const CURRENCIES = [
  { code: 'INR', label: 'Indian Rupee (₹)' },
  { code: 'USD', label: 'US Dollar ($)' },
  { code: 'EUR', label: 'Euro (€)' },
  { code: 'GBP', label: 'British Pound (£)' },
  { code: 'AED', label: 'UAE Dirham (د.إ)' },
  { code: 'SGD', label: 'Singapore Dollar (S$)' },
  { code: 'LKR', label: 'Sri Lankan Rupee (Rs)' },
]

/** Mirrors the server-side strength rules so the meter never lies. */
function strengthOf(password: string) {
  const checks = [
    password.length >= 8,
    password.length >= 12,
    /[a-z]/.test(password) && /[A-Z]/.test(password),
    /[0-9]/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ].filter(Boolean).length

  const labels = ['Too short', 'Weak', 'Fair', 'Good', 'Strong', 'Excellent']
  const colors = [
    'bg-destructive',
    'bg-destructive',
    'bg-warning',
    'bg-warning',
    'bg-success',
    'bg-success',
  ]
  return { value: (checks / 5) * 100, label: labels[checks], color: colors[checks] }
}

export function RegisterForm({ mode = 'trial' }: { mode?: 'trial' | 'request' }) {
  const [formError, setFormError] = React.useState<string | null>(null)
  const isTrial = mode === 'trial'

  const form = useForm<RegisterInput>({
    resolver: zodResolver(registerSchema),
    defaultValues: {
      restaurantName: '',
      ownerName: '',
      email: '',
      phone: '',
      password: '',
      confirmPassword: '',
      currency: 'INR',
      mode,
      acceptTerms: undefined as unknown as true,
    },
  })

  const password = form.watch('password')
  const strength = React.useMemo(() => strengthOf(password ?? ''), [password])

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null)
    const result = await registerAction(values)

    if (!result.ok) {
      setFormError(result.error)
      if (result.fieldErrors) {
        for (const [field, messages] of Object.entries(result.fieldErrors)) {
          form.setError(field as keyof RegisterInput, { message: messages[0] })
        }
      }
      return
    }

    toast.success(result.message ?? 'Your restaurant is ready')
    // Hard navigation so the new session cookie is used on the next request.
    window.location.assign(result.data.redirectTo)
  })

  return (
    <div className="space-y-7">
      <header className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight">
          {isTrial ? 'Start your free trial' : 'Buy a plan'}
        </h1>
        <p className="text-sm text-muted-foreground">
          {isTrial
            ? 'Full access for 30 days. No card needed — you’ll be signed in straight away.'
            : 'Tell us about your restaurant. An admin reviews your request and activates your account — you get full access once approved.'}
        </p>
      </header>

      {formError ? <Alert variant="destructive">{formError}</Alert> : null}

      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <input type="hidden" {...form.register('mode')} value={mode} />
        <Field
          label="Restaurant name"
          htmlFor="restaurantName"
          required
          error={form.formState.errors.restaurantName?.message}
        >
          <Input
            id="restaurantName"
            placeholder="The Copper Spoon"
            startIcon={<Building2 />}
            {...form.register('restaurantName')}
          />
        </Field>

        <Field
          label="Your name"
          htmlFor="ownerName"
          required
          error={form.formState.errors.ownerName?.message}
        >
          <Input id="ownerName" placeholder="Alex Fernandes" startIcon={<User />} {...form.register('ownerName')} />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
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

          <Field label="Phone" htmlFor="phone" required error={form.formState.errors.phone?.message}>
            <Input
              id="phone"
              type="tel"
              autoComplete="tel"
              placeholder="+91 98765 43210"
              startIcon={<Phone />}
              {...form.register('phone')}
            />
          </Field>
        </div>

        <Field label="Currency" error={form.formState.errors.currency?.message}>
          <Select
            defaultValue="INR"
            onValueChange={(value) => form.setValue('currency', value, { shouldValidate: true })}
          >
            <SelectTrigger>
              <SelectValue placeholder="Select currency" />
            </SelectTrigger>
            <SelectContent>
              {CURRENCIES.map((currency) => (
                <SelectItem key={currency.code} value={currency.code}>
                  {currency.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field
          label="Password"
          htmlFor="password"
          required
          error={form.formState.errors.password?.message}
        >
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 8 characters"
            startIcon={<Lock />}
            {...form.register('password')}
          />
          {password ? (
            <div className="mt-2 space-y-1">
              <Progress value={strength.value} indicatorClassName={strength.color} className="h-1.5" />
              <p
                className={cn(
                  'text-xs font-medium',
                  strength.value >= 80
                    ? 'text-success'
                    : strength.value >= 50
                      ? 'text-warning'
                      : 'text-destructive',
                )}
              >
                {strength.label}
              </p>
            </div>
          ) : null}
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
            placeholder="Repeat your password"
            startIcon={<Lock />}
            {...form.register('confirmPassword')}
          />
        </Field>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="mt-0.5 size-4 rounded border-input accent-[hsl(var(--primary))]"
            {...form.register('acceptTerms')}
          />
          <span>
            I agree to the terms of service and privacy policy.
            {form.formState.errors.acceptTerms ? (
              <span className="mt-0.5 block text-xs font-medium text-destructive">
                {form.formState.errors.acceptTerms.message}
              </span>
            ) : null}
          </span>
        </label>

        <Button type="submit" size="lg" className="w-full" loading={form.formState.isSubmitting}>
          {isTrial ? 'Start free trial' : 'Send purchase request'}
        </Button>
      </form>

      <p className="text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <Link href="/login" className="font-medium text-primary hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  )
}
