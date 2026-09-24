import { z } from 'zod'

import { phoneSchema } from '@/features/auth/schema'
import { imageUrlField } from '@/lib/media-url'

export const restaurantSettingsSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  tagline: z.string().trim().max(120).optional().or(z.literal('')),
  description: z.string().trim().max(500).optional().or(z.literal('')),
  logoUrl: imageUrlField(),
  coverUrl: imageUrlField(),
  email: z.string().email().max(255).optional().or(z.literal('')),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  addressLine: z.string().trim().max(200).optional().or(z.literal('')),
  city: z.string().trim().max(60).optional().or(z.literal('')),
  state: z.string().trim().max(60).optional().or(z.literal('')),
  postalCode: z.string().trim().max(20).optional().or(z.literal('')),
  currency: z.string().length(3),
  timezone: z.string().min(1).max(60),
  taxLabel: z.string().trim().min(1).max(20),
  taxRatePercent: z.coerce.number().min(0).max(100),
  taxInclusive: z.coerce.boolean().default(false),
  allowNegativeStock: z.coerce.boolean().default(false),
  serviceChargePercent: z.coerce.number().min(0).max(100),
  loyaltyEnabled: z.coerce.boolean().default(true),
  loyaltyEarnRate: z.coerce.number().min(0).max(100).default(1),
  // Value of one point when redeemed, in whole currency units (e.g. 0.10 = ₹0.10).
  loyaltyPointValue: z.coerce.number().min(0).max(10_000).default(1),
})
export type RestaurantSettingsInput = z.infer<typeof restaurantSettingsSchema>

export const paymentSettingsSchema = z.object({
  cash: z.coerce.boolean().default(true),
  card: z.coerce.boolean().default(true),
  qr: z.coerce.boolean().default(true),
  online: z.coerce.boolean().default(false),
  upiId: z.string().trim().max(80).optional().or(z.literal('')),
  payeeName: z.string().trim().max(80).optional().or(z.literal('')),
  // Direct bank / online transfer.
  bankTransfer: z.coerce.boolean().default(false),
  bankName: z.string().trim().max(80).optional().or(z.literal('')),
  accountName: z.string().trim().max(80).optional().or(z.literal('')),
  accountNumber: z.string().trim().max(40).optional().or(z.literal('')),
  bankBranch: z.string().trim().max(80).optional().or(z.literal('')),
  receiptWhatsapp: z.string().trim().max(24).optional().or(z.literal('')),
})
export type PaymentSettingsInput = z.infer<typeof paymentSettingsSchema>

/**
 * Where each payment method is allocated for accounting (bill.md §2).
 *
 * Its own schema and its own action, separate from the Payments form above,
 * because these are two different decisions: that form says which methods a
 * guest may choose, this one says which account the money is booked to. They
 * also fail differently — a bad destination map can stop a till taking money,
 * so it is checked far harder than a toggle.
 *
 * The invariant enforced here, and the reason this is not a plain record:
 * every method that points anywhere must point at a destination that exists
 * and is live. Saving a map with a dangling code would leave a till refusing
 * payments with no way for the owner to see why.
 */
export const paymentDestinationsSchema = z
  .object({
    destinations: z
      .array(
        z.object({
          // Minted once from the name, then frozen: stamped payments hold it.
          code: z
            .string()
            .trim()
            .min(1)
            .max(40)
            .regex(/^[a-z0-9_]+$/, 'A destination code may only use a-z, 0-9 and _'),
          name: z.string().trim().min(1, 'Give the account a name').max(60),
          kind: z.enum(['BANK', 'CASH', 'WALLET', 'GATEWAY', 'OTHER']).default('OTHER'),
          archived: z.coerce.boolean().default(false),
          /* Every bank detail is optional — an owner who only knows the bank's
           * name should be able to record that and get on with service. */
          bankName: z.string().trim().max(80).optional().or(z.literal('')),
          accountNumber: z.string().trim().max(40).optional().or(z.literal('')),
          holderName: z.string().trim().max(80).optional().or(z.literal('')),
          bankBranch: z.string().trim().max(80).optional().or(z.literal('')),
        }),
      )
      .max(40, 'That is more accounts than anybody reconciles'),
    /** METHOD → destination code. An empty string means "not booked anywhere". */
    methodDestinations: z.record(z.string(), z.string().trim().max(40)),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.destinations.forEach((destination, index) => {
      if (seen.has(destination.code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['destinations', index, 'code'],
          message: `Two accounts share the code "${destination.code}"`,
        })
      }
      seen.add(destination.code)
    })

    // A live destination is one a payment may be settled into today.
    const live = new Set(
      value.destinations.filter((destination) => !destination.archived).map((d) => d.code),
    )
    for (const [method, code] of Object.entries(value.methodDestinations)) {
      if (!code) continue
      if (!live.has(code)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['methodDestinations', method],
          message: `${method} points at an account that no longer exists or has been retired`,
        })
      }
    }
  })
export type PaymentDestinationsInput = z.infer<typeof paymentDestinationsSchema>

/**
 * Receipt and kitchen-ticket paper width, in millimetres.
 *
 * 58 mm and 80 mm are the two standard thermal roll sizes. The width decides the
 * page size and font scale of the printed document, so a receipt formatted for
 * 58 mm on an 80 mm printer wastes a third of the paper and prints small.
 */
export const printerSettingsSchema = z.object({
  receiptWidth: z.coerce.number().refine((v) => v === 58 || v === 80, 'Choose 58 mm or 80 mm'),
  kitchenWidth: z.coerce.number().refine((v) => v === 58 || v === 80, 'Choose 58 mm or 80 mm'),
})
export type PrinterSettingsInput = z.infer<typeof printerSettingsSchema>

/**
 * What a printed bill shows (bill.md §1).
 *
 * Every field is optional with a default, so a form that posts a subset — or a
 * toggle added to the interface after this restaurant last saved — still
 * resolves to something rather than to `undefined`.
 */
export const receiptFieldsSchema = z.object({
  logo: z.coerce.boolean().default(false),
  logoMono: z.coerce.boolean().default(true),
  restaurantName: z.coerce.boolean().default(true),
  address: z.coerce.boolean().default(true),
  phone: z.coerce.boolean().default(true),
  cashierName: z.coerce.boolean().default(false),
  invoiceNumber: z.coerce.boolean().default(true),
  dateTime: z.coerce.boolean().default(true),
  customer: z.coerce.boolean().default(true),
  itemNames: z.coerce.boolean().default(true),
  quantity: z.coerce.boolean().default(true),
  unitPrice: z.coerce.boolean().default(false),
  discount: z.coerce.boolean().default(true),
  subtotal: z.coerce.boolean().default(true),
  serviceCharge: z.coerce.boolean().default(true),
  tax: z.coerce.boolean().default(true),
  rounding: z.coerce.boolean().default(true),
  grandTotal: z.coerce.boolean().default(true),
  paymentMethod: z.coerce.boolean().default(true),
  paidAmount: z.coerce.boolean().default(true),
  balance: z.coerce.boolean().default(true),
  footer: z.coerce.boolean().default(true),
  footerText: z.string().trim().max(160).default(''),
  /*
   * The logo lives on the restaurant, not in the receipt blob — but it is set
   * HERE, beside the switch that decides whether it prints. Sending an owner to
   * another tab to find the thing the toggle refers to is how a toggle looks
   * broken.
   */
  logoUrl: imageUrlField().optional(),
})
export type ReceiptFieldsInput = z.infer<typeof receiptFieldsSchema>

/**
 * The cash controls.
 *
 * Amounts are entered in major units — the owner types what they would say out
 * loud, "five hundred rupees" as `500` — and the action converts with the
 * restaurant's own currency factor. Zero means "never": a variance threshold of
 * zero sends nothing for review, which is the pre-existing behaviour and has to
 * stay expressible.
 */
export const cashControlsSchema = z.object({
  cashVarianceAbove: z.coerce.number().min(0).max(9_999_999),
  pettyCashApprovalAbove: z.coerce.number().min(0).max(9_999_999),
  requireCashierSession: z.coerce.boolean().default(true),
})
export type CashControlsInput = z.infer<typeof cashControlsSchema>

/**
 * The live floor board's thresholds.
 *
 * ── Why the refinements matter ──────────────────────────────────────────────
 *
 * The waiting bands are read as a ladder — normal, then watch, then attention,
 * then delayed, then everything above. If they are not strictly increasing the
 * ladder has a rung that can never be reached: with `watchMax` below
 * `normalMax`, nothing is ever WATCH, and the owner who typed it has no way to
 * see why. The same is true of the return gaps, where a long-time return
 * threshold below the welcome-back one silently retires one of the two badges.
 *
 * Caught here rather than in the UI so it holds however the action is reached.
 */
export const liveBoardPolicySchema = z
  .object({
    normalMax: z.coerce.number().int().min(1).max(600),
    watchMax: z.coerce.number().int().min(1).max(600),
    attentionMax: z.coerce.number().int().min(1).max(600),
    delayedMax: z.coerce.number().int().min(1).max(600),

    noFoodServedMin: z.coerce.number().int().min(1).max(600),
    readyNotServedMin: z.coerce.number().int().min(1).max(600),
    stuckPreparingMin: z.coerce.number().int().min(1).max(600),
    paymentPendingMin: z.coerce.number().int().min(1).max(600),
    longServiceMin: z.coerce.number().int().min(5).max(1440),
    sensitiveWaitingMin: z.coerce.number().int().min(1).max(600),
    serviceRequestMin: z.coerce.number().int().min(1).max(120),
    lowProgressPct: z.coerce.number().int().min(1).max(99),

    regularAfterVisits: z.coerce.number().int().min(2).max(500),
    vipAfterVisits: z.coerce.number().int().min(2).max(1000),
    /** Major units on the way in; the action converts. 0 turns the route off. */
    vipAfterSpend: z.coerce.number().min(0).max(99_999_999),

    welcomeBackDays: z.coerce.number().int().min(1).max(3650),
    longTimeReturnDays: z.coerce.number().int().min(1).max(3650),
  })
  .superRefine((value, ctx) => {
    const ladder: Array<[keyof typeof value, keyof typeof value, string]> = [
      ['watchMax', 'normalMax', 'Watch must be longer than normal'],
      ['attentionMax', 'watchMax', 'Attention must be longer than watch'],
      ['delayedMax', 'attentionMax', 'Delayed must be longer than attention'],
    ]
    for (const [field, previous, message] of ladder) {
      if (value[field] <= value[previous]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message })
      }
    }
    if (value.vipAfterVisits <= value.regularAfterVisits) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['vipAfterVisits'],
        message: 'VIP must take more visits than regular',
      })
    }
    if (value.longTimeReturnDays <= value.welcomeBackDays) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['longTimeReturnDays'],
        message: 'A long-time return must be a longer gap than a welcome back',
      })
    }
  })
export type LiveBoardPolicyInput = z.infer<typeof liveBoardPolicySchema>

/**
 * How guests are met, on every code (ar.md §13, §19).
 *
 * One setting for the ordinary table QR and every QR menu alike: a guest
 * scanning the table card and a guest scanning the takeaway poster should meet
 * the same restaurant. Text fields are capped rather than required — a blank
 * falls back to the built-in wording in `readAppearance`, so an owner cannot
 * leave a guest reading an empty heading.
 */
export const guestAppearanceSchema = z.object({
  showLogo: z.coerce.boolean(),
  showTagline: z.coerce.boolean(),
  showHours: z.coerce.boolean(),
  showPoweredBy: z.coerce.boolean(),
  showTiles: z.coerce.boolean(),
  showFooter: z.coerce.boolean(),

  headingText: z.string().trim().max(80).optional().or(z.literal('')),
  helperText: z.string().trim().max(160).optional().or(z.literal('')),
  buttonText: z.string().trim().max(40).optional().or(z.literal('')),
  footerNote: z.string().trim().max(120).optional().or(z.literal('')),
  noTableHeadingText: z.string().trim().max(80).optional().or(z.literal('')),
  noTableHelperText: z.string().trim().max(160).optional().or(z.literal('')),

  menuShowSearch: z.coerce.boolean(),
  menuShowPrices: z.coerce.boolean(),
  menuShowImages: z.coerce.boolean(),
  menuShowDescriptions: z.coerce.boolean(),
  menuShowFeatured: z.coerce.boolean(),
  menuShowDietFilter: z.coerce.boolean(),
  menuShowCallStaff: z.coerce.boolean(),
  menuLayout: z.enum(['LIST', 'GRID']),

  checkoutShowCoupon: z.coerce.boolean(),
  checkoutShowName: z.coerce.boolean(),
  checkoutShowPhone: z.coerce.boolean(),
  checkoutShowNote: z.coerce.boolean(),
  checkoutShowPointsEarned: z.coerce.boolean(),
  checkoutDetailsHeading: z.string().trim().max(60).optional().or(z.literal('')),
  checkoutPhoneHint: z.string().trim().max(120).optional().or(z.literal('')),

  trackShowSteps: z.coerce.boolean(),
  trackShowItems: z.coerce.boolean(),
  trackShowLoyalty: z.coerce.boolean(),
  trackAllowAdding: z.coerce.boolean(),
  trackShowBill: z.coerce.boolean(),
  trackShowEdit: z.coerce.boolean(),

  accentMode: z.enum(['AUTO', 'CUSTOM']),
  accentColour: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, 'Use a colour like #f97316')
    .optional()
    .or(z.literal('')),
})

/**
 * A shop's own SMS gateway.
 *
 * Shape and format only. Three rules that need server state live in the action
 * instead: that a trigger cannot be switched on before a test send has
 * succeeded, that a template references no unknown placeholder, and that the
 * gateway URL survives the SSRF guard. A zod schema imported by a client
 * component can check none of those.
 */
const smsSpecSchema = z.object({
  method: z.enum(['GET', 'POST']),
  url: z.string().trim().max(2000),
  headers: z.record(z.string().max(200)).default({}),
  bodyEncoding: z.enum(['none', 'json', 'form']),
  bodyTemplate: z.string().max(4000).default(''),
  authMode: z.enum(['none', 'field', 'bearer', 'basic', 'header']),
  authHeader: z.string().trim().max(100).optional(),
  successKind: z.enum(['httpStatus', 'jsonEquals', 'jsonTruthy', 'bodyContains']),
  successPath: z.string().trim().max(200).optional(),
  /** Comma-separated on the way in; the action splits it. */
  successEquals: z.string().trim().max(400).optional(),
  successNeedle: z.string().trim().max(200).optional(),
  messageIdPath: z.string().trim().max(200).optional(),
  errorMessagePath: z.string().trim().max(200).optional(),
  errorCodePath: z.string().trim().max(200).optional(),
  numberFormat: z.enum(['e164Plus', 'e164NoPlus', 'nationalLeadingZero']),
  encoding: z.enum(['auto', 'gsm7', 'unicode']),
  unicodeFieldName: z.string().trim().max(100).optional(),
  unicodeGsm7Value: z.string().trim().max(100).optional(),
  unicodeValue: z.string().trim().max(100).optional(),
})

export const smsConfigSchema = z
  .object({
    enabled: z.coerce.boolean(),
    provider: z.enum(['notifylk', 'textlk', 'dialog', 'mobitel', 'custom']),
    /*
     * An alphanumeric mask is at most 11 characters and a numeric one at most
     * 15 — a GSM limit, not ours, and a mask over it is silently replaced by
     * the operator's default.
     */
    senderId: z.string().trim().max(15),
    senderIdApproved: z.coerce.boolean(),

    /** Empty means LEAVE UNCHANGED, which is what makes a write-only field usable. */
    credentials: z
      .object({
        apiKey: z.string().max(512).optional(),
        apiSecret: z.string().max(512).optional(),
        username: z.string().max(128).optional(),
        password: z.string().max(512).optional(),
        accountId: z.string().max(128).optional(),
      })
      .default({}),

    spec: smsSpecSchema.nullish(),

    caps: z.object({
      perDay: z.coerce.number().int().min(1).max(10_000),
      perRecipientPerDay: z.coerce.number().int().min(1).max(100),
      otpPerHour: z.coerce.number().int().min(1).max(5_000),
    }),

    /** Typed in whole currency; the action converts to minor units. */
    cost: z.coerce.number().min(0).max(10_000).nullish(),
    costCurrency: z.string().trim().max(8).nullish(),

    triggers: z.object({
      otp: z.coerce.boolean(),
      receipt: z.coerce.boolean(),
      orderReady: z.coerce.boolean(),
      reservationConfirm: z.coerce.boolean(),
      reservationReminder: z.coerce.boolean(),
      marketing: z.coerce.boolean(),
    }),

    templates: z.record(z.string().max(480)).default({}),

    trialOnlyVerified: z.coerce.boolean(),
    /** One number per line on the way in; the action normalises to phoneKey form. */
    verifiedRecipients: z.string().max(4000).default(''),
    optOut: z.string().max(20_000).default(''),
  })
  .superRefine((value, ctx) => {
    const needsOwnSpec = value.provider === 'custom' || value.provider === 'dialog' || value.provider === 'mobitel'

    if (needsOwnSpec && !value.spec?.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['spec', 'url'],
        message: 'This gateway has no built-in endpoint — paste the send URL from its documentation',
      })
    }

    if (value.spec) {
      if (value.spec.successKind === 'jsonEquals' && !value.spec.successPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'successPath'],
          message: 'Give the field to read, e.g. status',
        })
      }
      if (value.spec.successKind === 'jsonEquals' && !value.spec.successEquals) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'successEquals'],
          message: 'Give the value that means success, e.g. success',
        })
      }
      if (value.spec.successKind === 'jsonTruthy' && !value.spec.successPath) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'successPath'],
          message: 'Give the field that is present on success, e.g. sid',
        })
      }
      if (value.spec.successKind === 'bodyContains' && !value.spec.successNeedle) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'successNeedle'],
          message: 'Give the text that means success, e.g. OK',
        })
      }
      if (value.spec.authMode === 'header' && !value.spec.authHeader) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'authHeader'],
          message: 'Name the header your gateway expects, e.g. X-API-Key',
        })
      }
      /*
       * A gateway that needs an explicit unicode flag and does not get one
       * sends Sinhala as mojibake, which arrives looking like a delivery
       * success and reads as nonsense.
       */
      if (value.spec.encoding !== 'gsm7' && value.spec.unicodeFieldName && !value.spec.unicodeValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['spec', 'unicodeValue'],
          message: 'Give the value this field takes for a unicode message',
        })
      }
    }

    /* A mask nobody approved delivers nothing, and does it without an error. */
    const anyTrigger = Object.values(value.triggers).some(Boolean)
    if (anyTrigger && !value.senderIdApproved) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['senderIdApproved'],
        message: 'Confirm your sender mask is approved before switching any messages on',
      })
    }
    if (anyTrigger && !value.senderId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['senderId'],
        message: 'A sender ID is needed before any messages can be sent',
      })
    }
    /* Marketing is the only one that legally needs a way out. */
    if (value.triggers.marketing && !value.templates.marketing?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['templates', 'marketing'],
        message: 'Write the offer message, including how to opt out',
      })
    }
  })

export type SmsConfigInput = z.infer<typeof smsConfigSchema>

/** One test message to one number, from the settings page. */
export const smsTestSchema = z.object({
  to: phoneSchema,
  message: z.string().trim().min(1, 'Write something to send').max(480),
})
export type SmsTestInput = z.infer<typeof smsTestSchema>
