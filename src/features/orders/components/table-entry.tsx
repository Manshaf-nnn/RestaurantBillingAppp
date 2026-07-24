'use client'

import * as React from 'react'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { ArrowRight, Clock, MapPin, Utensils } from 'lucide-react'
import { toast } from 'sonner'

import { Alert } from '@/components/ui/feedback'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { resolveTable } from '../actions'
import { useCart } from '../cart-store'

interface TableEntryProps {
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  city: string | null
  isOpen: boolean
  openingLabel: string | null
}

/**
 * The QR landing screen.
 *
 * A single code is printed for the whole restaurant; the guest identifies their
 * table by typing its number here. Keeps operations simple — moving or adding
 * tables never means reprinting codes.
 */
export function TableEntry({
  restaurantName,
  tagline,
  logoUrl,
  coverUrl,
  city,
  isOpen,
  openingLabel,
}: TableEntryProps) {
  const router = useRouter()
  const { setTable, state } = useCart()
  const [value, setValue] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)
  const [pending, startTransition] = React.useTransition()
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (state.table?.tableNumber) setValue(state.table.tableNumber)
  }, [state.table?.tableNumber])

  React.useEffect(() => {
    // Autofocus on desktop only; on phones this would pop the keyboard over
    // the restaurant branding before the guest has read anything.
    if (window.matchMedia('(pointer: fine)').matches) inputRef.current?.focus()
  }, [])

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)

    const trimmed = value.trim()
    if (!trimmed) {
      setError('Enter the number printed on your table')
      return
    }

    startTransition(async () => {
      const result = await resolveTable({ tableNumber: trimmed })
      if (!result.ok) {
        setError(result.error)
        return
      }
      setTable(result.data)
      toast.success(`Table ${result.data.tableNumber} — welcome!`)
      router.push('/order/menu')
    })
  }

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="relative h-52 shrink-0 overflow-hidden bg-gradient-to-br from-primary to-chart-5">
        {coverUrl ? (
          <Image
            src={coverUrl}
            alt=""
            fill
            priority
            sizes="(max-width: 512px) 100vw, 512px"
            className="object-cover opacity-60"
          />
        ) : null}
        <div className="absolute inset-0 bg-gradient-to-t from-background via-background/20 to-transparent" />
      </div>

      <div className="-mt-16 flex flex-1 flex-col px-6 pb-10">
        <div className="animate-fade-up text-center">
          <div className="mx-auto flex size-20 items-center justify-center overflow-hidden rounded-2xl border-4 border-background bg-card shadow-elevated">
            {logoUrl ? (
              <Image src={logoUrl} alt={restaurantName} width={80} height={80} className="size-full object-cover" />
            ) : (
              <Utensils className="size-8 text-primary" />
            )}
          </div>

          <h1 className="mt-4 text-balance text-2xl font-bold tracking-tight">{restaurantName}</h1>
          {tagline ? (
            <p className="mt-1.5 text-balance text-sm text-muted-foreground">{tagline}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {city ? (
              <span className="flex items-center gap-1">
                <MapPin className="size-3.5" /> {city}
              </span>
            ) : null}
            {openingLabel ? (
              <span className="flex items-center gap-1">
                <Clock className="size-3.5" /> {openingLabel}
              </span>
            ) : null}
            <span
              className={cn(
                'flex items-center gap-1.5 font-medium',
                isOpen ? 'text-success' : 'text-destructive',
              )}
            >
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  isOpen ? 'animate-pulse bg-success' : 'bg-destructive',
                )}
              />
              {isOpen ? 'Open now' : 'Closed'}
            </span>
          </div>
        </div>

        <div className="mt-10 flex flex-1 flex-col justify-center">
          <form onSubmit={submit} className="space-y-5">
            <div className="text-center">
              <label htmlFor="tableNumber" className="text-lg font-semibold tracking-tight">
                What is your table number?
              </label>
              <p className="mt-1 text-sm text-muted-foreground">
                You will find it on the stand or card on your table.
              </p>
            </div>

            <input
              ref={inputRef}
              id="tableNumber"
              name="tableNumber"
              value={value}
              onChange={(event) => {
                setValue(event.target.value.toUpperCase().slice(0, 10))
                setError(null)
              }}
              inputMode="numeric"
              autoComplete="off"
              autoCapitalize="characters"
              placeholder="12"
              aria-invalid={Boolean(error)}
              aria-describedby={error ? 'table-error' : undefined}
              className={cn(
                'mx-auto block h-24 w-full max-w-[220px] rounded-2xl border-2 bg-card text-center text-5xl font-bold tracking-[0.15em] shadow-soft transition-all',
                'placeholder:text-muted-foreground/30 focus:outline-none focus:ring-4 focus:ring-primary/20',
                error ? 'border-destructive' : 'border-input focus:border-primary',
              )}
            />

            {error ? (
              <div id="table-error">
                <Alert variant="destructive" className="text-center">
                  {error}
                </Alert>
              </div>
            ) : null}

            <Button type="submit" size="xl" className="w-full" loading={pending}>
              Continue to the menu <ArrowRight />
            </Button>
          </form>
        </div>

        <p className="mt-8 text-center text-xs text-muted-foreground">
          No app, no sign-up. Order straight from your phone.
        </p>
      </div>
    </div>
  )
}
