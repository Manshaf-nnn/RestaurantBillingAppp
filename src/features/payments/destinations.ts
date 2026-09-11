/**
 * The payment config and its accounting destinations (bill.md §2).
 *
 * Pulled out of `payments/service.ts` — which is `server-only` — because the
 * Settings screen that defines these has to be a client component, and a
 * screen that lets an owner map methods to accounts cannot be written without
 * the shape of a method or an account. `service.ts` re-exports every name
 * below, so nothing that already imports from there had to change.
 *
 * Everything here is pure: no Prisma, no request, no `server-only`.
 */
import type { PaymentMethod } from '@prisma/client'

/** Every method, in the order a screen should list them. */
export const PAYMENT_METHOD_ORDER: PaymentMethod[] = [
  'CASH',
  'CARD',
  'QR',
  'ONLINE',
  'WALLET',
  'BANK_TRANSFER',
  'OTHER',
]

/**
 * Turns the name an owner typed into the code a payment will carry forever.
 *
 * Minted once, at creation, and never recomputed on rename: the name is a
 * label and the code is an identity, and rewriting the identity when somebody
 * fixes a typo is exactly what would orphan a year of stamped payments.
 */
export function slugifyDestinationCode(name: string, taken: string[] = []): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32) || 'account'

  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base}_${n}`)) n += 1
  return `${base}_${n}`
}

export interface PaymentConfig {
  cash?: boolean
  card?: boolean
  qr?: boolean
  online?: boolean
  upiId?: string
  payeeName?: string
  // Direct bank / online transfer — the owner's account shown to guests.
  bankTransfer?: boolean
  bankName?: string
  accountName?: string
  accountNumber?: string
  bankBranch?: string
  /// WhatsApp number guests send their transfer receipt to.
  receiptWhatsapp?: string

  /*
   * Where the money is allocated for accounting (bill.md §2).
   *
   * TableFlow moves no money — it has no gateway and no bank API — so this is
   * bookkeeping, not a transfer: it records which account the owner considers
   * a payment to have landed in. `destinations` is the book of accounts;
   * `methodDestinations` points each method at one of them BY CODE.
   *
   * The code, not the name, is what a payment stamps. A code is minted once
   * and never edited, so grouping a year of reports is stable; the name is
   * editable, so correcting "HBN" to "HNB" fixes every label including
   * historical ones — which is what an owner means by fixing a typo, and is
   * different from rewriting what happened.
   */
  destinations?: PaymentDestination[]
  methodDestinations?: Partial<Record<string, string>>
}

export interface PaymentDestination {
  /** Stable slug. Minted once, never edited. */
  code: string
  /** The display name — editable. */
  name: string
  kind?: 'BANK' | 'CASH' | 'WALLET' | 'OTHER'
  /**
   * Retired: hidden from new settlements, kept so historical payments still
   * resolve a name. Deleting instead would leave stamped codes dangling.
   */
  archived?: boolean
}

/**
 * The destinations a restaurant has before anybody configures any.
 *
 * Named after the methods themselves, because that is the one naming nobody
 * can find wrong, and an owner renames them to real banks the first time they
 * look. They exist so that "never opened the setting" is not the same state as
 * "switched a method off": a till with no configuration keeps working, and the
 * refusal is reserved for a restaurant that HAS a configuration which does not
 * cover the method being tendered.
 */
export const DEFAULT_DESTINATIONS: PaymentDestination[] = [
  { code: 'cash', name: 'Cash', kind: 'CASH' },
  { code: 'card', name: 'Card', kind: 'BANK' },
  { code: 'qr', name: 'QR', kind: 'BANK' },
  { code: 'online', name: 'Online', kind: 'BANK' },
  { code: 'wallet', name: 'Wallet', kind: 'WALLET' },
  { code: 'bank_transfer', name: 'Bank transfer', kind: 'BANK' },
  { code: 'other', name: 'Other', kind: 'OTHER' },
]

export const DEFAULT_METHOD_DESTINATIONS: Record<string, string> = {
  CASH: 'cash',
  CARD: 'card',
  QR: 'qr',
  ONLINE: 'online',
  WALLET: 'wallet',
  BANK_TRANSFER: 'bank_transfer',
  OTHER: 'other',
}

const DEFAULT_PAYMENT_CONFIG: PaymentConfig = {
  cash: true,
  card: true,
  qr: true,
  destinations: DEFAULT_DESTINATIONS,
  methodDestinations: DEFAULT_METHOD_DESTINATIONS,
}

/** What each method is called on a screen or a receipt. */
export const METHOD_LABELS: Record<string, string> = {
  CASH: 'Cash',
  CARD: 'Card',
  QR: 'QR',
  ONLINE: 'Online',
  WALLET: 'Wallet',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
}

/**
 * Settlement now depends on this, so it can no longer be a blind cast.
 *
 * It still never throws: one malformed JSON blob in one restaurant's settings
 * must not be able to stop that restaurant taking money. Bad shapes degrade to
 * the defaults, which the caller then refuses on for a reason it can explain.
 */
export function readPaymentConfig(value: unknown): PaymentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return DEFAULT_PAYMENT_CONFIG
  const raw = value as Record<string, unknown>

  const destinations = Array.isArray(raw.destinations)
    ? (raw.destinations as unknown[]).filter(
        (entry): entry is PaymentDestination =>
          Boolean(entry) &&
          typeof entry === 'object' &&
          typeof (entry as PaymentDestination).code === 'string' &&
          typeof (entry as PaymentDestination).name === 'string',
      )
    : undefined

  const methodDestinations =
    raw.methodDestinations && typeof raw.methodDestinations === 'object' && !Array.isArray(raw.methodDestinations)
      ? Object.fromEntries(
          Object.entries(raw.methodDestinations as Record<string, unknown>).filter(
            ([, code]) => typeof code === 'string' && code.length > 0,
          ),
        ) as Partial<Record<string, string>>
      : undefined

  /*
   * Absent is not the same as empty. A restaurant that has never opened the
   * setting falls back to the defaults and keeps trading; one that HAS a map
   * and left a method out of it is the case worth refusing, because somebody
   * made a decision there and this method was not part of it.
   */
  return {
    ...(raw as PaymentConfig),
    destinations: destinations ?? DEFAULT_DESTINATIONS,
    methodDestinations: methodDestinations ?? DEFAULT_METHOD_DESTINATIONS,
  }
}

/** The destination a method is pointed at, or null when it has none live. */
export function destinationForMethod(
  config: PaymentConfig,
  method: string,
): PaymentDestination | null {
  const code = config.methodDestinations?.[method]
  if (!code) return null
  const found = config.destinations?.find((entry) => entry.code === code)
  // An archived destination is not a destination you may settle into: that is
  // what stops one being retired out from under a till mid-service.
  return found && !found.archived ? found : null
}

/** The display name for a stamped code — falls back to the code itself. */
export function destinationName(config: PaymentConfig, code: string | null | undefined): string {
  if (!code) return 'Unassigned'
  return config.destinations?.find((entry) => entry.code === code)?.name ?? code
}
