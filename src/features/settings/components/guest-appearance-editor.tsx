'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { CreditCard, Eye, LayoutTemplate, RotateCcw, Smartphone, UtensilsCrossed } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/primitives'
import { SectionCard } from '@/features/dashboard/components/page-header'
import {
  DEFAULT_APPEARANCE,
  type GuestAppearance,
  type MenuLayout,
} from '@/features/guest/appearance'
import {
  GuestCover,
  GuestPrompt,
  GuestSubmit,
  useBrandAccent,
} from '@/features/guest/components/guest-cover'
import { updateGuestAppearance } from '@/features/settings/actions'
import { callAction } from '@/lib/use-action'
import { cn } from '@/lib/utils'
import { CheckoutPreview, MenuPreview, TrackingPreview } from './guest-page-previews'

/**
 * The guest app has five screens, and an owner thinks about them one at a
 * time. So the editor is a switcher: pick a screen, change what it shows and
 * what it says, watch it change beside you. One screen's controls on screen at
 * once — the alternative is forty switches in a column, which is how an owner
 * gives up.
 */
const PAGES = [
  { key: 'front', label: 'Welcome', icon: LayoutTemplate },
  { key: 'menu', label: 'Menu', icon: UtensilsCrossed },
  { key: 'checkout', label: 'Checkout', icon: CreditCard },
  { key: 'tracking', label: 'Order tracking', icon: Smartphone },
] as const

type PageKey = (typeof PAGES)[number]['key']

/**
 * What guests see when they scan (ar.md §13, §19).
 *
 * ── The preview is the real screen ──────────────────────────────────────────
 *
 * §19 says "do not build a fake preview", and the same argument applies here:
 * a mock-up of the welcome screen would be a second thing to keep in step with
 * the first. So the panel on the right renders the SAME `GuestCover` a guest
 * gets, from the same state the form is editing — change a word and it changes
 * there, before anything is saved.
 *
 * ── Why the choices are grouped this way ────────────────────────────────────
 *
 * An owner does not think in fields; they think "the welcome screen", "what it
 * says", "the menu", "the colour". Each section is one of those, every control
 * is a plain switch with a sentence saying what it does, and nothing here asks
 * for a technical value.
 */
export function GuestAppearanceEditor({
  appearance: saved,
  restaurantName,
  tagline,
  logoUrl,
  coverUrl,
  isOpen,
  openingLabel,
}: {
  appearance: GuestAppearance
  restaurantName: string
  tagline: string | null
  logoUrl: string | null
  coverUrl: string | null
  isOpen: boolean
  openingLabel: string | null
}) {
  const router = useRouter()
  const [form, setForm] = React.useState<GuestAppearance>(saved)
  const [busy, setBusy] = React.useState(false)
  const accent = useBrandAccent(logoUrl, coverUrl)

  const set = <K extends keyof GuestAppearance>(key: K, value: GuestAppearance[K]) =>
    setForm((current) => ({ ...current, [key]: value }))

  const dirty = JSON.stringify(form) !== JSON.stringify(saved)

  const save = async () => {
    setBusy(true)
    const result = await callAction(() => updateGuestAppearance(form))
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error)
      return
    }
    toast.success('Saved — your guests see this now')
    router.refresh()
  }

  const [page, setPage] = React.useState<PageKey>('front')
  const [previewTable, setPreviewTable] = React.useState(true)

  return (
    <div className="space-y-4">
      {/* ── Which screen ─────────────────────────────────────────────────── */}
      <div className="flex flex-wrap gap-2">
        {PAGES.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => setPage(entry.key)}
            aria-pressed={page === entry.key}
            className={cn(
              'flex items-center gap-2 rounded-xl border px-3 py-2 text-sm font-medium transition-colors',
              page === entry.key ? 'border-primary bg-primary/10 text-primary' : 'hover:bg-muted',
            )}
          >
            <entry.icon className="size-4" />
            {entry.label}
          </button>
        ))}
      </div>

      <div className="grid gap-5 pb-24 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-5">
          {page === 'front' ? (
            <>
              <SectionCard
                title="What the welcome screen shows"
                description="The first thing a guest sees. Turn off anything you would rather not show."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Toggle checked={form.showLogo} onChange={(v) => set('showLogo', v)} title="Your logo" hint="A badge above your name. A branded placeholder shows until you upload one." />
                  <Toggle checked={form.showTagline} onChange={(v) => set('showTagline', v)} title="Your tagline" hint="The short line under your name." />
                  <Toggle checked={form.showHours} onChange={(v) => set('showHours', v)} title="Opening hours" hint="Today’s hours, with an Open or Closed dot." />
                  <Toggle checked={form.showTiles} onChange={(v) => set('showTiles', v)} title="Scan · Order · Track · Pay" hint="The four tiles that explain how it works." />
                  <Toggle checked={form.showPoweredBy} onChange={(v) => set('showPoweredBy', v)} title="Powered by TableFlow" hint="The badge at the top of the card." />
                  <Toggle checked={form.showFooter} onChange={(v) => set('showFooter', v)} title="Footer line" hint="The copyright line at the very bottom." />
                </div>
              </SectionCard>

              <SectionCard title="What it says" description="Your own wording. Leave a box empty to go back to ours.">
                <div className="space-y-4">
                  <Text label="Heading — codes on a table" value={form.headingText} placeholder={DEFAULT_APPEARANCE.headingText} onChange={(v) => set('headingText', v)} hint="Asked when the code is on a table." />
                  <Text label="Helper line" value={form.helperText} placeholder={DEFAULT_APPEARANCE.helperText} onChange={(v) => set('helperText', v)} />
                  <Text label="Heading — delivery and takeaway codes" value={form.noTableHeadingText} placeholder={DEFAULT_APPEARANCE.noTableHeadingText} onChange={(v) => set('noTableHeadingText', v)} hint="Shown instead when a code does not ask for a table number." />
                  <Text label="Helper line" value={form.noTableHelperText} placeholder={DEFAULT_APPEARANCE.noTableHelperText} onChange={(v) => set('noTableHelperText', v)} />
                  <Text label="Button" value={form.buttonText} placeholder={DEFAULT_APPEARANCE.buttonText} onChange={(v) => set('buttonText', v)} />
                  <Text label="Small print under the tiles" value={form.footerNote} placeholder={DEFAULT_APPEARANCE.footerNote} onChange={(v) => set('footerNote', v)} />
                </div>
              </SectionCard>

              <SectionCard title="Your colour" description="Used for buttons, highlights and the glow behind the card.">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice checked={form.accentMode === 'AUTO'} onChange={() => set('accentMode', 'AUTO')} title="From my logo" hint="Picked out of your own artwork. What your guests see today." />
                  <Choice checked={form.accentMode === 'CUSTOM'} onChange={() => set('accentMode', 'CUSTOM')} title="Choose a colour" hint="For a logo that is black and white, or a colour of your own." />
                </div>
                {form.accentMode === 'CUSTOM' ? (
                  <div className="mt-3 flex items-center gap-3">
                    <input
                      type="color"
                      value={form.accentColour}
                      onChange={(event) => set('accentColour', event.target.value)}
                      className="h-10 w-16 cursor-pointer rounded-lg border border-input bg-background p-1"
                      aria-label="Accent colour"
                    />
                    <Input value={form.accentColour} onChange={(event) => set('accentColour', event.target.value)} className="max-w-[10rem] font-mono text-sm" maxLength={7} />
                  </div>
                ) : null}
              </SectionCard>
            </>
          ) : null}

          {page === 'menu' ? (
            <>
              <SectionCard title="How the menu is laid out">
                <div className="grid gap-2 sm:grid-cols-2">
                  <Choice checked={form.menuLayout === 'LIST'} onChange={() => set('menuLayout', 'LIST' as MenuLayout)} title="List" hint="A row per dish with the photo on the right. Best for a long menu." />
                  <Choice checked={form.menuLayout === 'GRID'} onChange={() => set('menuLayout', 'GRID' as MenuLayout)} title="Cards" hint="Two across, photo on top. Best for a short menu with good photography." />
                </div>
              </SectionCard>
              <SectionCard title="What the menu shows">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Toggle checked={form.menuShowSearch} onChange={(v) => set('menuShowSearch', v)} title="Search box" hint="Let guests type to find a dish." />
                  <Toggle checked={form.menuShowPrices} onChange={(v) => set('menuShowPrices', v)} title="Prices" hint="Turn off for a menu with no prices on it." />
                  <Toggle checked={form.menuShowImages} onChange={(v) => set('menuShowImages', v)} title="Photos" hint="Off gives a clean text menu that loads faster." />
                  <Toggle checked={form.menuShowDescriptions} onChange={(v) => set('menuShowDescriptions', v)} title="Descriptions" hint="The line under each dish name." />
                  <Toggle checked={form.menuShowFeatured} onChange={(v) => set('menuShowFeatured', v)} title="Chef’s picks row" hint="A row of your recommended and popular dishes at the top." />
                  <Toggle checked={form.menuShowDietFilter} onChange={(v) => set('menuShowDietFilter', v)} title="Veg / Non-veg chips" hint="Lets a guest narrow the menu by diet." />
                  <Toggle checked={form.menuShowCallStaff} onChange={(v) => set('menuShowCallStaff', v)} title="Call a waiter" hint="The button in the menu header. Needs a table, so it never shows on a takeaway code." />
                </div>
              </SectionCard>
            </>
          ) : null}

          {page === 'tracking' ? (
            <>
              <SectionCard title="What the tracking screen shows" description="Where a guest watches their order after they have ordered.">
                <div className="grid gap-3 sm:grid-cols-2">
                  <Toggle checked={form.trackShowSteps} onChange={(v) => set('trackShowSteps', v)} title="Progress steps" hint="Received → Preparing → Ready → Served." />
                  <Toggle checked={form.trackShowItems} onChange={(v) => set('trackShowItems', v)} title="Each dish's state" hint="Per-item progress under the steps." />
                  <Toggle checked={form.trackShowLoyalty} onChange={(v) => set('trackShowLoyalty', v)} title="Loyalty points" hint="Only appears if loyalty is on for the restaurant." />
                  <Toggle checked={form.trackAllowAdding} onChange={(v) => set('trackAllowAdding', v)} title="Add more items" hint="Let them add to an open, unpaid order from here." />
                  <Toggle checked={form.trackShowBill} onChange={(v) => set('trackShowBill', v)} title="View bill" hint="The button through to their bill." />
                  <Toggle checked={form.trackShowEdit} onChange={(v) => set('trackShowEdit', v)} title="Update your order" hint="Changing quantities after it has gone to the kitchen." />
                </div>
              </SectionCard>
            </>
          ) : null}

          {page === 'checkout' ? (
            <>
              <SectionCard
                title="What the checkout asks for"
                description="Where a guest enters their name and number before placing the order. Both boxes are optional for the guest — these decide whether they appear at all."
              >
                <div className="grid gap-3 sm:grid-cols-2">
                  <Toggle checked={form.checkoutShowName} onChange={(v) => set('checkoutShowName', v)} title="Name" hint="Optional for the guest either way." />
                  <Toggle checked={form.checkoutShowPhone} onChange={(v) => set('checkoutShowPhone', v)} title="Mobile number" hint="How a customer is recognised." />
                  <Toggle checked={form.checkoutShowNote} onChange={(v) => set('checkoutShowNote', v)} title="Note for the kitchen" hint="Allergies, spice, anything else." />
                  <Toggle checked={form.checkoutShowCoupon} onChange={(v) => set('checkoutShowCoupon', v)} title="Coupon box" hint="Turn off if you do not run codes." />
                  <Toggle checked={form.checkoutShowPointsEarned} onChange={(v) => set('checkoutShowPointsEarned', v)} title="Points they will earn" hint="Under the total. Only shows when loyalty is on." />
                </div>
                {!form.checkoutShowPhone ? (
                  <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                    Without a number there is no customer record for the order — so no loyalty points, and
                    no offer aimed at a customer can apply.
                  </p>
                ) : null}
              </SectionCard>

              <SectionCard title="What it says">
                <div className="space-y-4">
                  <Text label="Heading over the boxes" value={form.checkoutDetailsHeading} placeholder={DEFAULT_APPEARANCE.checkoutDetailsHeading} onChange={(v) => set('checkoutDetailsHeading', v)} />
                  <Text label="Line under the number" value={form.checkoutPhoneHint} placeholder={DEFAULT_APPEARANCE.checkoutPhoneHint} onChange={(v) => set('checkoutPhoneHint', v)} />
                </div>
              </SectionCard>

              {/*
                The bill is NOT repeated here. What a guest's bill shows is
                already `ReceiptFields` on Printer & bill — read by the printed
                bill and the on-screen one alike — and two forms deciding one
                thing is how they come to disagree.
              */}
              <SectionCard
                title="The bill itself"
                description="What the finished bill shows — your logo, subtotal, discount, service charge, tax, total — is set with the printed bill, so the two always agree."
              >
                <Button variant="outline" asChild>
                  <a href="/dashboard/settings?tab=printer">Open Printer &amp; bill</a>
                </Button>
              </SectionCard>
            </>
          ) : null}

        </div>

        {/* ── The preview ───────────────────────────────────────────────── */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="rounded-2xl border bg-card p-3 shadow-soft">
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <Smartphone className="size-4" /> Live preview
              </p>
              {page === 'front' ? (
                <div className="flex rounded-lg border p-0.5 text-xs">
                  <button type="button" onClick={() => setPreviewTable(true)} className={cn('rounded-md px-2 py-1', previewTable && 'bg-muted font-medium')}>
                    Table
                  </button>
                  <button type="button" onClick={() => setPreviewTable(false)} className={cn('rounded-md px-2 py-1', !previewTable && 'bg-muted font-medium')}>
                    Delivery
                  </button>
                </div>
              ) : null}
            </div>

            {page === 'front' ? (
              <div className="h-[34rem] overflow-hidden rounded-2xl border bg-black">
                <GuestCover
                  restaurantName={restaurantName}
                  tagline={tagline}
                  logoUrl={logoUrl}
                  coverUrl={coverUrl}
                  isOpen={isOpen}
                  openingLabel={openingLabel}
                  appearance={form}
                  sampled={accent}
                  embedded
                >
                  <GuestPrompt
                    heading={previewTable ? form.headingText : form.noTableHeadingText}
                    helper={previewTable ? form.helperText : form.noTableHelperText}
                  />
                  {previewTable ? (
                    <div className="guest-control mt-3.5 flex h-14 items-center rounded-xl border px-3.5">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/5 text-amber-400">
                        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M3 7h18" /><path d="M5 7v13" /><path d="M19 7v13" />
                          <path d="M8 12h8" /><path d="M12 7v5" />
                        </svg>
                      </div>
                      <div className="guest-divider mx-3 h-6 w-px shrink-0" />
                      <span className="guest-ink w-full text-center text-2xl font-extrabold tracking-wider opacity-40">5</span>
                    </div>
                  ) : null}
                  <div className="pointer-events-none mt-3.5">
                    <GuestSubmit label={form.buttonText} />
                  </div>
                </GuestCover>
              </div>
            ) : null}

            {page === 'menu' ? <MenuPreview appearance={form} /> : null}
            {page === 'checkout' ? <CheckoutPreview appearance={form} /> : null}
            {page === 'tracking' ? <TrackingPreview appearance={form} /> : null}

            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <Eye className="size-3.5" />
              {page === 'front'
                ? 'This is the real screen, not a mock-up.'
                : 'Drawn from the same settings the real screen reads. Dishes and figures are samples.'}
            </p>
          </div>
        </div>
      </div>

      <div className="fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 p-3 backdrop-blur lg:pl-64">
        <div className="mx-auto flex max-w-5xl items-center justify-end gap-3">
          <p className="mr-auto text-xs text-muted-foreground">
            {dirty ? 'Not saved yet — your guests still see the old version.' : 'Your guests see this now.'}
          </p>
          <Button variant="ghost" onClick={() => setForm(DEFAULT_APPEARANCE)} disabled={busy}>
            <RotateCcw /> Start again
          </Button>
          <Button size="lg" onClick={save} loading={busy} disabled={!dirty}>
            Save
          </Button>
        </div>
      </div>
    </div>
  )
}

function Text({
  label,
  value,
  placeholder,
  onChange,
  hint,
}: {
  label: string
  value: string
  placeholder: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-sm">{label}</Label>
      <Input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean
  onChange: (value: boolean) => void
  title: string
  hint: string
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border p-3">
      <Checkbox checked={checked} onCheckedChange={(value) => onChange(value === true)} className="mt-0.5" />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

function Choice({
  checked,
  onChange,
  title,
  hint,
}: {
  checked: boolean
  onChange: () => void
  title: string
  hint: string
}) {
  return (
    <button
      type="button"
      onClick={onChange}
      aria-pressed={checked}
      className={cn(
        'rounded-xl border p-3 text-left transition-colors',
        checked ? 'border-primary bg-primary/5' : 'hover:bg-muted',
      )}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
    </button>
  )
}
