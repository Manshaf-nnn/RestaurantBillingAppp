'use client'

import * as React from 'react'
import { Coins, Sparkles, Tag } from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { formatMoney } from '@/lib/money'
import { callAction } from '@/lib/use-action'
import { offersForCustomerAction } from '../actions'
import type { OfferForCustomer } from '../discounts'

/**
 * Who this guest is, what they can be offered, and what their points are worth
 * (pro.A.md §4, §10).
 *
 * ── Why one component and not two ───────────────────────────────────────────
 *
 * This app has two order-entry forms — the Orders tab and the Cashier tab's
 * New order dialog — and every customer feature so far has been built into one
 * of them. The phone lookup landed in both; the name badge only in the first;
 * the Add Customer button only in the first. The result is that the same
 * question gets a different answer depending on which screen the cashier
 * happened to open, which is worse than the feature being missing.
 *
 * So this is the whole guest half of an order column, mounted by both.
 *
 * ── The offers are the point ────────────────────────────────────────────────
 *
 * An owner can aim a discount at "regulars who have not been in for a month",
 * and until now the only way to use it was to know a code nobody was ever
 * told. The cashier already asks for a phone number; this turns that number
 * into the list of offers that number qualifies for, evaluated by the same
 * function that will re-check them at payment.
 *
 * Near misses are shown too, greyed, with their reason. "Spend 500 more" is a
 * sentence that sells another dish.
 */
export interface GuestLine {
  foodId: string | null
  categoryId: string | null
  quantity: number
  lineTotal: number
}

export function GuestPanel({
  customer,
  lines,
  branchId,
  currency,
  locale,
  couponCode,
  onCouponChange,
  redeemPoints,
  onRedeemPointsChange,
  loyalty,
  /** What the bill is worth before any of this, so points cannot exceed it. */
  discountableTotal,
  compact = false,
}: {
  customer: { id: string; name: string; loyaltyPoints: number } | null
  lines: GuestLine[]
  branchId?: string | null
  currency: string
  locale?: string
  couponCode: string
  /**
   * The code AND what it takes off, because the column above has to show the
   * guest a total before the order is sent. The amount is an estimate from the
   * same evaluator the server will run; placement returns the real figure.
   */
  onCouponChange: (code: string, amount: number) => void
  redeemPoints: number
  onRedeemPointsChange: (points: number) => void
  loyalty?: { enabled: boolean; pointValue: number }
  discountableTotal: number
  compact?: boolean
}) {
  const [offers, setOffers] = React.useState<OfferForCustomer[]>([])
  const [looking, setLooking] = React.useState(false)
  const money = (minor: number) => formatMoney(minor, currency, locale)

  const customerId = customer?.id ?? null
  /*
   * The basket as a stable string, so the effect below re-runs when what is in
   * the cart changes and not on every render. Sending the array itself would
   * fire a request per keystroke anywhere on the screen.
   */
  const basket = React.useMemo(
    () => JSON.stringify(lines.map((line) => [line.foodId, line.categoryId, line.quantity, line.lineTotal])),
    [lines],
  )

  React.useEffect(() => {
    if (!customerId) {
      setOffers([])
      return
    }
    let live = true
    setLooking(true)
    // Debounced: the cart changes on every tap of + and −.
    const timer = setTimeout(() => {
      void callAction(() =>
        offersForCustomerAction({
          customerId,
          branchId: branchId ?? '',
          lines: JSON.parse(basket).map(
            ([foodId, categoryId, quantity, lineTotal]: [string | null, string | null, number, number]) => ({
              foodId,
              categoryId,
              quantity,
              lineTotal,
            }),
          ),
        }),
      ).then((result) => {
        if (!live) return
        setLooking(false)
        // A cashier without DISCOUNT_APPLY is refused this, and correctly sees
        // no offers rather than an error they cannot act on.
        setOffers(result.ok ? result.data.offers : [])
      })
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [customerId, branchId, basket])

  const applied = offers.find((offer) => offer.code === couponCode)

  /*
   * The basket moves under a chosen offer — another dish, a quantity change —
   * and its value moves with it. Re-lifting on every recalculation keeps the
   * total above this panel honest; without it the screen would go on showing
   * what the offer was worth two taps ago.
   */
  React.useEffect(() => {
    if (!couponCode) return
    /*
     * Never reconcile against a list that is still arriving. The basket
     * changes on every tap of +, and clearing the cashier's chosen offer
     * during each in-flight lookup would make it impossible to keep one
     * selected while building an order.
     */
    if (looking) return
    if (!applied || !applied.ok) {
      // It stopped applying: drop it rather than promise a discount the
      // server is about to refuse.
      onCouponChange('', 0)
      return
    }
    onCouponChange(applied.code, applied.amount)
    // `onCouponChange` is a setter from the parent and is not a dependency —
    // including it would re-run this on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [couponCode, looking, applied?.ok, applied?.amount])

  if (!customer) return null

  const pointValue = loyalty?.pointValue ?? 0
  const canRedeem = Boolean(loyalty?.enabled) && pointValue > 0 && customer.loyaltyPoints > 0

  /*
   * Never offer more points than the bill can absorb, nor more than the guest
   * has. The server clamps both again — this only stops the cashier typing a
   * number that will come back smaller than they promised the guest.
   */
  const affordableByBill = pointValue > 0 ? Math.floor(Math.max(0, discountableTotal) / pointValue) : 0
  const maxPoints = Math.min(customer.loyaltyPoints, affordableByBill)
  const pointsWorth = Math.min(redeemPoints, maxPoints) * pointValue

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="success" size="sm">{customer.name || 'Guest'}</Badge>
        {customer.loyaltyPoints > 0 ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Sparkles className="size-3" />
            {customer.loyaltyPoints.toLocaleString()} points
            {pointValue > 0 ? ` · worth ${money(customer.loyaltyPoints * pointValue)}` : ''}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No points yet</span>
        )}
      </div>

      {/* ── Offers this guest qualifies for ──────────────────────────────── */}
      {looking && offers.length === 0 ? (
        <p className="text-xs text-muted-foreground">Checking their offers…</p>
      ) : null}

      {offers.length > 0 ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-xs font-medium">
            <Tag className="size-3" /> Offers for this customer
          </p>
          <ul className="space-y-1">
            {offers.map((offer) => {
              const chosen = offer.code === couponCode
              const label =
                offer.description ||
                (offer.type === 'PERCENT' ? `${offer.value / 100}% off` : `${money(offer.value)} off`)
              return (
                <li key={offer.id}>
                  <button
                    type="button"
                    disabled={!offer.ok}
                    onClick={() => onCouponChange(chosen ? '' : offer.code, chosen ? 0 : offer.amount)}
                    className={`flex w-full items-start justify-between gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs transition-colors ${
                      chosen
                        ? 'border-primary bg-primary text-primary-foreground'
                        : offer.ok
                          ? 'bg-background hover:bg-muted'
                          : 'cursor-not-allowed bg-background opacity-60'
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block font-medium">{label}</span>
                      {/*
                        The reason, not a dead "unavailable". A cashier told
                        "spend 500 more" can sell another dish; one told "no"
                        can only apologise.
                      */}
                      {!offer.ok && offer.reason ? (
                        <span className="block opacity-80">{offer.reason}</span>
                      ) : null}
                    </span>
                    {offer.ok && offer.amount > 0 ? (
                      <span className="shrink-0 font-semibold tabular-nums">
                        −{money(offer.amount)}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })}
          </ul>
          {applied ? (
            <p className="text-xs text-emerald-600 dark:text-emerald-400">
              Applied. It is checked again when the order is sent.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* ── Spending points ──────────────────────────────────────────────── */}
      {canRedeem ? (
        <div className="space-y-1.5">
          <p className="flex items-center gap-1 text-xs font-medium">
            <Coins className="size-3" /> Use points
          </p>
          {maxPoints <= 0 ? (
            <p className="text-xs text-muted-foreground">
              This bill is too small to take a point off yet.
            </p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={maxPoints}
                  className={compact ? 'h-8' : 'h-9'}
                  value={redeemPoints || ''}
                  placeholder="0"
                  onChange={(event) => {
                    const wanted = Math.max(0, Math.floor(Number(event.target.value) || 0))
                    onRedeemPointsChange(Math.min(wanted, maxPoints))
                  }}
                  aria-label="Points to use"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => onRedeemPointsChange(maxPoints)}
                >
                  Use {maxPoints.toLocaleString()}
                </Button>
                {redeemPoints > 0 ? (
                  <Button type="button" size="sm" variant="ghost" onClick={() => onRedeemPointsChange(0)}>
                    Clear
                  </Button>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">
                {redeemPoints > 0
                  ? `Takes ${money(pointsWorth)} off. ${(customer.loyaltyPoints - redeemPoints).toLocaleString()} points left.`
                  : `Up to ${maxPoints.toLocaleString()} points on this bill · ${money(maxPoints * pointValue)}`}
              </p>
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}
