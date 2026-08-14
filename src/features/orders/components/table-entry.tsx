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
import CoverPage from '@/components/CoverPage'

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
        {/* Cover page header (background, theme extraction handled in component) */}
        <CoverPage
          restaurantName={restaurantName}
          tagline={tagline}
          logoUrl={logoUrl}
          coverUrl={coverUrl}
          city={city}
          isOpen={isOpen}
          openingLabel={openingLabel}
        />
        

        {/* Table input and continue button moved into CoverPage (glass card) */}
      </div>
    </div>
  )
}
