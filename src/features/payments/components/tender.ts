import {
  Banknote,
  CircleEllipsis,
  CreditCard,
  Landmark,
  QrCode,
  Smartphone,
  Wallet,
} from 'lucide-react'

/**
 * How money is taken, wherever it is taken.
 *
 * The till's payment panel and the orders screen's Take-payment dialog
 * (abc.md §1) show the same methods in the same order with the same icons;
 * one list here keeps them from drifting apart.
 *
 * Every method is recordable, including BANK_TRANSFER and OTHER: the spec
 * forbids PROCESSING (no gateways), not the record. The reference field
 * carries the transfer id or what OTHER was.
 */
export const TENDER_METHODS = [
  { key: 'CASH' as const, label: 'Cash', icon: Banknote },
  { key: 'CARD' as const, label: 'Card', icon: CreditCard },
  { key: 'QR' as const, label: 'QR / UPI', icon: QrCode },
  { key: 'ONLINE' as const, label: 'Online', icon: Smartphone },
  { key: 'WALLET' as const, label: 'Wallet', icon: Wallet },
  // Recorded, never processed (§6). The reference field carries the proof.
  { key: 'BANK_TRANSFER' as const, label: 'Bank transfer', icon: Landmark },
  { key: 'OTHER' as const, label: 'Other', icon: CircleEllipsis },
]

export type TenderMethod = (typeof TENDER_METHODS)[number]['key']

/** Cash-drawer style presets: exact, then the next sensible round notes. */
export function quickCash(amountMinor: number, currency: string): number[] {
  const factor = currency.toUpperCase() === 'JPY' ? 1 : 100
  const major = amountMinor / factor
  const rounds = [50, 100, 200, 500, 1000, 2000]
  const presets = rounds.filter((value) => value > major).slice(0, 3)
  return [amountMinor, ...presets.map((value) => value * factor)]
}
