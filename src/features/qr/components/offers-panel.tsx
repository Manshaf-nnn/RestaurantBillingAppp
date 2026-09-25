import { BadgePercent } from 'lucide-react'

import type { OffersPanel as OffersPanelData } from '../offers'

/**
 * What this guest is offered, on the menu they are looking at.
 *
 * ── Why it is a server component with no state ──────────────────────────────
 *
 * Nothing here is interactive. The codes are read, remembered and typed into
 * the coupon box at the checkout — deliberately not a "tap to apply" button,
 * because applying a coupon is the cart's job and it re-prices on the server.
 * A button here would either duplicate that or lie about having done it.
 *
 * Renders nothing at all when there is nothing to say. An empty "Offers" card
 * is worse than no card: it tells a guest to expect discounts and then shows
 * them none.
 */
export function OffersPanel({ data }: { data: OffersPanelData }) {
  if (!data.hasAny) return null

  return (
    <section className="surface space-y-3 p-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        <BadgePercent className="size-4 text-primary" />
        Offers
      </h2>

      {data.offers.length > 0 ? (
        <ul className="space-y-2">
          {data.offers.map((offer) => (
            <li
              key={offer.id}
              className="rounded-lg border border-border bg-background/60 px-3 py-2"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                <span className="text-sm font-medium">{offer.headline}</span>
                {/*
                  The code, as the guest will have to type it. Monospaced and
                  upper-cased because that is how it is entered, and a code you
                  cannot read off the screen is not an offer.
                */}
                <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs font-semibold uppercase">
                  {offer.code}
                </span>
              </div>
              {offer.description ? (
                <p className="mt-0.5 text-xs text-muted-foreground">{offer.description}</p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}

      {data.note ? (
        /*
         * The owner's own words. `whitespace-pre-line` so the line breaks they
         * typed survive — a list of three offers written on three lines should
         * not arrive as one paragraph.
         */
        <p className="whitespace-pre-line text-xs text-muted-foreground">{data.note}</p>
      ) : null}

      {data.offers.length > 0 ? (
        <p className="text-[11px] text-muted-foreground">
          Enter the code at checkout to apply it.
        </p>
      ) : null}
    </section>
  )
}
