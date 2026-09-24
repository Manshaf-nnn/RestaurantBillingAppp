'use client'

import * as React from 'react'
import { Check, ChefHat, CircleDollarSign, Clock, Search, Star, Utensils } from 'lucide-react'

import { cn } from '@/lib/utils'
import type { GuestAppearance } from '@/features/guest/appearance'

/**
 * What each guest page looks like, inside the settings editor.
 *
 * ── Why these are drawn here and not mounted for real ───────────────────────
 *
 * The welcome screen's preview IS the real `GuestCover`, because that
 * component needs nothing but the appearance object. The menu, the tracker and
 * the bill are not like that: each needs a live order, a cart provider, a
 * socket connection and a priced menu, and standing all of that up inside a
 * settings form would be a second, fragile copy of the guest app that breaks
 * whenever the real one changes.
 *
 * So these are drawn from the SAME appearance object the real screens read,
 * with sample rows, and every switch on the left visibly moves something on
 * the right. They are labelled as samples on screen rather than pretending to
 * be a guest's actual order.
 */

const SAMPLE_DISHES = [
  { name: 'Chicken Kottu', description: 'Shredded roti, egg, chicken, house spice', price: 'Rs 1,450', popular: true },
  { name: 'Devilled Prawns', description: 'Sweet chilli, onion, capsicum', price: 'Rs 2,200', popular: false },
  { name: 'Watalappan', description: 'Jaggery, coconut, cardamom', price: 'Rs 650', popular: false },
]

export function MenuPreview({ appearance }: { appearance: GuestAppearance }) {
  return (
    <Frame>
      <div className="border-b px-3 py-2.5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold">Our menu</p>
          {appearance.menuShowCallStaff ? (
            <span className="rounded-lg border px-2 py-0.5 text-[10px] font-semibold">🙋 Call</span>
          ) : null}
        </div>
        {appearance.menuShowSearch ? (
          <div className="mt-2 flex h-8 items-center gap-2 rounded-lg border bg-background/60 px-2 text-xs text-muted-foreground">
            <Search className="size-3.5" />
            Search the menu…
          </div>
        ) : null}
        <div className="mt-2 flex gap-1.5">
          {appearance.menuShowDietFilter ? (
            <>
              <span className="rounded-full border px-2 py-0.5 text-[10px]"><span className="text-emerald-500">●</span> Veg</span>
              <span className="rounded-full border px-2 py-0.5 text-[10px]"><span className="text-red-500">●</span> Non-veg</span>
            </>
          ) : null}
          {['All', 'Mains', 'Desserts'].map((chip, index) => (
            <span
              key={chip}
              className={cn(
                'rounded-full border px-2 py-0.5 text-[10px]',
                index === 0 && 'border-primary bg-primary/10 text-primary',
              )}
            >
              {chip}
            </span>
          ))}
        </div>
      </div>

      <div className="space-y-2 p-3">
        {appearance.menuShowFeatured ? (
          <div>
            <p className="mb-1.5 flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
              <Star className="size-3" /> Chef’s picks
            </p>
            <div className="flex gap-2">
              {SAMPLE_DISHES.slice(0, 2).map((dish) => (
                <div key={dish.name} className="w-28 shrink-0 rounded-lg border p-1.5">
                  {appearance.menuShowImages ? <Swatch className="h-12 w-full" /> : null}
                  <p className="mt-1 truncate text-[10px] font-semibold">{dish.name}</p>
                  {appearance.menuShowPrices ? (
                    <p className="text-[10px] text-primary">{dish.price}</p>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <p className="pt-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Mains</p>

        {appearance.menuLayout === 'GRID' ? (
          <div className="grid grid-cols-2 gap-2">
            {SAMPLE_DISHES.map((dish) => (
              <div key={dish.name} className="rounded-lg border p-2">
                {appearance.menuShowImages ? <Swatch className="mb-1.5 h-16 w-full" /> : null}
                <p className="truncate text-[11px] font-semibold">{dish.name}</p>
                {appearance.menuShowDescriptions ? (
                  <p className="line-clamp-2 text-[10px] text-muted-foreground">{dish.description}</p>
                ) : null}
                {appearance.menuShowPrices ? (
                  <p className="mt-0.5 text-[11px] font-bold text-primary">{dish.price}</p>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="space-y-2">
            {SAMPLE_DISHES.map((dish) => (
              <div key={dish.name} className="flex gap-2 rounded-lg border p-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[11px] font-semibold">{dish.name}</p>
                  {appearance.menuShowDescriptions ? (
                    <p className="line-clamp-2 text-[10px] text-muted-foreground">{dish.description}</p>
                  ) : null}
                  {appearance.menuShowPrices ? (
                    <p className="mt-0.5 text-[11px] font-bold text-primary">{dish.price}</p>
                  ) : null}
                </div>
                {appearance.menuShowImages ? <Swatch className="size-14 shrink-0" /> : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </Frame>
  )
}

const STEPS = [
  { label: 'Received', icon: Check },
  { label: 'Preparing', icon: ChefHat },
  { label: 'Ready', icon: Utensils },
  { label: 'Served', icon: Check },
]

export function TrackingPreview({ appearance }: { appearance: GuestAppearance }) {
  return (
    <Frame>
      <div className="border-b px-3 py-2.5 text-center">
        <p className="text-sm font-bold">Order #1042</p>
        <p className="text-[10px] text-muted-foreground">Your food is being prepared</p>
      </div>

      <div className="space-y-3 p-3">
        {appearance.trackShowSteps ? (
          <ol className="space-y-2">
            {STEPS.map((step, index) => {
              const done = index <= 1
              return (
                <li key={step.label} className="flex items-center gap-2">
                  <span
                    className={cn(
                      'flex size-6 shrink-0 items-center justify-center rounded-full',
                      done ? 'bg-primary text-primary-foreground' : 'border bg-muted text-muted-foreground',
                    )}
                  >
                    <step.icon className="size-3" />
                  </span>
                  <span className={cn('text-[11px]', done ? 'font-semibold' : 'text-muted-foreground')}>
                    {step.label}
                  </span>
                  {index === 1 ? (
                    <span className="ml-auto flex items-center gap-1 text-[10px] text-warning">
                      <Clock className="size-3" /> now
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        ) : null}

        {appearance.trackShowItems ? (
          <div className="rounded-lg border p-2">
            <p className="mb-1.5 text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Your items</p>
            {SAMPLE_DISHES.slice(0, 2).map((dish, index) => (
              <div key={dish.name} className="flex items-center justify-between py-1 text-[11px]">
                <span className="truncate">{dish.name}</span>
                <span
                  className={cn(
                    'rounded-full px-1.5 py-0.5 text-[9px] font-semibold',
                    index === 0 ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning',
                  )}
                >
                  {index === 0 ? 'Ready' : 'Preparing'}
                </span>
              </div>
            ))}
          </div>
        ) : null}

        {appearance.trackShowLoyalty ? (
          <div className="flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 p-2">
            <CircleDollarSign className="size-4 shrink-0 text-primary" />
            <p className="text-[10px]">
              <span className="font-semibold">240 points</span> — worth Rs 240 off
            </p>
          </div>
        ) : null}

        {appearance.trackShowBill || appearance.trackAllowAdding ? (
          <div className={cn('grid gap-2', appearance.trackShowBill && appearance.trackAllowAdding ? 'grid-cols-2' : 'grid-cols-1')}>
            {appearance.trackShowBill ? (
              <div className="rounded-lg border py-1.5 text-center text-[10px] font-semibold">View bill</div>
            ) : null}
            {appearance.trackAllowAdding ? (
              <div className="rounded-lg border py-1.5 text-center text-[10px] font-semibold">Add more items</div>
            ) : null}
          </div>
        ) : null}

        {appearance.trackShowEdit ? (
          <div className="rounded-lg border p-2">
            <p className="text-[10px] font-bold">Update your order</p>
            <p className="text-[9px] text-muted-foreground">Add a few more or remove what you no longer need.</p>
          </div>
        ) : null}
      </div>
    </Frame>
  )
}

/**
 * The checkout — the screen the owner means by "where they enter their name
 * and number". There is no separate details page; it is a section of this one.
 */
export function CheckoutPreview({ appearance }: { appearance: GuestAppearance }) {
  return (
    <Frame>
      <div className="border-b px-3 py-2.5">
        <p className="text-sm font-bold">Your order</p>
        <p className="text-[10px] text-muted-foreground">Table 5</p>
      </div>

      <div className="space-y-2 p-3">
        <div className="rounded-lg border">
          {SAMPLE_DISHES.slice(0, 2).map((dish) => (
            <div key={dish.name} className="flex items-center justify-between border-b p-2 text-[11px] last:border-0">
              <span className="truncate pr-2">{dish.name}</span>
              <span className="tabular-nums">{dish.price}</span>
            </div>
          ))}
        </div>

        {appearance.checkoutShowCoupon ? (
          <div className="rounded-lg border p-2">
            <p className="text-[10px] font-bold">Have a coupon?</p>
            <div className="mt-1 flex gap-1.5">
              <span className="flex-1 rounded-md border px-2 py-1 text-[10px] text-muted-foreground">WELCOME10</span>
              <span className="rounded-md border px-2 py-1 text-[10px] font-semibold">Apply</span>
            </div>
          </div>
        ) : null}

        {appearance.checkoutShowName || appearance.checkoutShowPhone || appearance.checkoutShowNote ? (
          <div className="space-y-1.5 rounded-lg border p-2">
            <p className="text-[10px] font-bold">{appearance.checkoutDetailsHeading}</p>
            {appearance.checkoutShowName ? <FormRow label="Name (optional)" /> : null}
            {appearance.checkoutShowPhone ? (
              <>
                <FormRow label="Mobile number (optional)" />
                {appearance.checkoutPhoneHint ? (
                  <p className="text-[9px] text-muted-foreground">{appearance.checkoutPhoneHint}</p>
                ) : null}
              </>
            ) : null}
            {appearance.checkoutShowNote ? <FormRow label="Note for the kitchen" /> : null}
          </div>
        ) : null}

        <div className="space-y-1 rounded-lg border p-2 text-[11px]">
          <p className="mb-1 text-[10px] font-bold">Bill summary</p>
          <Line label="Item total" value="Rs 3,650" />
          <Line label="Service charge" value="Rs 365" muted />
          <Line label="VAT 15%" value="Rs 548" muted />
          <div className="flex justify-between border-t pt-1 text-xs font-bold">
            <span>To pay</span>
            <span className="tabular-nums">Rs 4,563</span>
          </div>
          {appearance.checkoutShowPointsEarned ? (
            <p className="mt-1 rounded-md bg-primary/5 px-2 py-1 text-[9px] font-medium text-primary">
              ✨ You’ll earn 45 points on this order
            </p>
          ) : null}
        </div>

        <div className="rounded-lg bg-gradient-to-r from-orange-500 to-amber-500 py-2 text-center text-[11px] font-bold text-white">
          Place order
        </div>

        <p className="rounded-lg bg-muted/50 p-2 text-[9px] leading-relaxed text-muted-foreground">
          What the finished bill shows — logo, subtotal, tax, service charge — is set under
          Settings → Printer &amp; bill, so the printed and on-screen bill always agree.
        </p>
      </div>
    </Frame>
  )
}

function FormRow({ label }: { label: string }) {
  return (
    <div className="flex h-7 items-center rounded-md border px-2">
      <span className="text-[9px] text-muted-foreground">{label}</span>
    </div>
  )
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="h-[34rem] overflow-y-auto rounded-2xl border bg-background">
      {children}
    </div>
  )
}

function Swatch({ className }: { className?: string }) {
  return (
    <div className={cn('flex items-center justify-center rounded-md bg-muted text-muted-foreground', className)}>
      <Utensils className="size-4 opacity-50" />
    </div>
  )
}

function Line({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className={cn('flex justify-between', muted && 'text-muted-foreground')}>
      <span>{label}</span>
      <span className="tabular-nums">{value}</span>
    </div>
  )
}
