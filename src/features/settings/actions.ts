'use server'

import { revalidatePath } from 'next/cache'
import type { Prisma } from '@prisma/client'

import { getLiveBoardPolicy } from '@/features/live/policy'
import { readPaymentConfig } from '@/features/payments/service'
import { readAppearance } from '@/features/guest/appearance'
import { phoneKey } from '@/features/customers/phone'
import {
  countryFor,
  gatewayHostAllowlist,
  mergeCredentials,
  pruneCredentials,
  readSmsConfig,
  resolveFrom,
} from '@/features/sms/config'
import { prepareRequest, unknownTokensIn } from '@/features/sms/http-adapter'
import { E164_FAILURE_MESSAGE, toE164 } from '@/features/sms/msisdn'
import type { HttpGatewaySpec, SmsConfig } from '@/features/sms/types'
import { assertSafeGatewayUrl } from '@/server/security/ssrf'
import { enforceRateLimit } from '@/server/security/rate-limit'
import { sendSms } from '@/server/sms/send'
import { ValidationError } from '@/lib/errors'
import { runAction, runSafe, type ActionResult } from '@/lib/action'
import { bpsFromPercent } from '@/lib/money'
import { PERMISSIONS } from '@/lib/rbac'
import { AUDIT_ACTIONS, audit } from '@/server/audit'
import { requirePermission } from '@/server/auth/guard'
import { prisma } from '@/server/db/prisma'
import { requireRestaurant } from '@/server/db/tenant'
import { minorUnitFactor } from '@/lib/money'
import { getApprovalPolicy } from '@/features/approvals/service'
import {
  cashControlsSchema,
  guestAppearanceSchema,
  liveBoardPolicySchema,
  paymentDestinationsSchema,
  paymentSettingsSchema,
  printerSettingsSchema,
  receiptFieldsSchema,
  restaurantSettingsSchema,
  smsConfigSchema,
  smsTestSchema,
  type SmsConfigInput,
} from './schema'

export async function updateRestaurantSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    restaurantSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const before = await prisma.restaurant.findUnique({
        where: { id: user.restaurantId },
        select: {
          name: true, currency: true, taxRateBps: true,
          serviceChargeBps: true, taxInclusive: true, timezone: true,
        },
      })

      const updated = await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          name: data.name,
          tagline: data.tagline || null,
          description: data.description || null,
          logoUrl: data.logoUrl || null,
          coverUrl: data.coverUrl || null,
          email: data.email || null,
          phone: data.phone || null,
          addressLine: data.addressLine || null,
          city: data.city || null,
          state: data.state || null,
          postalCode: data.postalCode || null,
          currency: data.currency,
          timezone: data.timezone,
          taxLabel: data.taxLabel,
          taxRateBps: bpsFromPercent(data.taxRatePercent),
          taxInclusive: data.taxInclusive,
          allowNegativeStock: data.allowNegativeStock,
          serviceChargeBps: bpsFromPercent(data.serviceChargePercent),
          loyaltyEnabled: data.loyaltyEnabled,
          loyaltyEarnRateX100: Math.round(data.loyaltyEarnRate * 100),
          // Stored in minor units (paise/cents).
          loyaltyPointValue: Math.round(data.loyaltyPointValue * 100),
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        // The full before/after of the money-shaping fields: tax and service
        // rates decide every bill, and a change to them with no prior value
        // recorded is unexplainable a month later.
        before: {
          name: before?.name,
          currency: before?.currency,
          taxRateBps: before?.taxRateBps,
          serviceChargeBps: before?.serviceChargeBps,
          taxInclusive: before?.taxInclusive,
          timezone: before?.timezone,
        },
        after: {
          name: data.name,
          currency: data.currency,
          taxRateBps: updated.taxRateBps,
          serviceChargeBps: updated.serviceChargeBps,
          taxInclusive: updated.taxInclusive,
          timezone: updated.timezone,
        },
      })

      revalidatePath('/dashboard/settings')
      return { id: updated.id }
    },
    'Settings saved.',
  )
}

export async function updatePaymentSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    paymentSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      /*
       * Read, merge, write — not write.
       *
       * This used to hand Prisma an object literal of exactly the twelve keys
       * this form owns, which silently deleted every key it does not: the
       * moment anything else lives in `paymentConfig` (the destinations map
       * below does), saving the Payments tab would wipe it. `updateLiveBoardPolicy`
       * already does it the right way; this now matches.
       */
      const existing = readPaymentConfig(
        (await prisma.restaurant.findUniqueOrThrow({
          where: { id: user.restaurantId },
          select: { paymentConfig: true },
        })).paymentConfig,
      )

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          paymentConfig: {
            ...existing,
            cash: data.cash,
            card: data.card,
            qr: data.qr,
            online: data.online,
            upiId: data.upiId || undefined,
            payeeName: data.payeeName || undefined,
            bankTransfer: data.bankTransfer,
            bankName: data.bankName || undefined,
            accountName: data.accountName || undefined,
            accountNumber: data.accountNumber || undefined,
            bankBranch: data.bankBranch || undefined,
            receiptWhatsapp: data.receiptWhatsapp || undefined,
          } as unknown as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { payments: 'updated' },
      })

      revalidatePath('/dashboard/settings')
      return { id: user.restaurantId }
    },
    'Payment settings saved.',
  )
}

/**
 * Where each method's money is booked (bill.md §2).
 *
 * A separate action from the Payments form above, writing the same column
 * through the same read-merge-write, because the two forms are saved
 * independently and neither may clobber the other's keys.
 *
 * The audit entry carries `before` as well as `after`: this map decides which
 * account a payment is allocated to, so "who changed Card from HNB to BOC, and
 * when" is a question the books have to be able to answer (§4).
 */
export async function updatePaymentDestinations(
  input: unknown,
): Promise<ActionResult<{ id: string }>> {
  return runAction(
    paymentDestinationsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const existing = readPaymentConfig(
        (await prisma.restaurant.findUniqueOrThrow({
          where: { id: user.restaurantId },
          select: { paymentConfig: true },
        })).paymentConfig,
      )

      /*
       * A code that a payment already carries can never be dropped, only
       * retired. Deleting one would leave stamped payments pointing at nothing
       * and every historical report reading the raw code instead of a name.
       */
      const stamped = await prisma.payment.findMany({
        where: { restaurantId: user.restaurantId, destination: { not: null } },
        select: { destination: true },
        distinct: ['destination'],
      })
      const kept = data.destinations.map((destination) => destination.code)
      const orphaned = stamped
        .map((row) => row.destination)
        .filter((code): code is string => code !== null && !kept.includes(code))

      const survivors = orphaned.map((code) => {
        const previous = existing.destinations?.find((entry) => entry.code === code)
        // Everything it had, retired — not a stub. Rebuilding it from a couple
        // of fields would silently drop the bank details the owner recorded,
        // which are exactly what a retired account is still consulted for when
        // reconciling the month it was live.
        return { ...previous, code, name: previous?.name ?? code, archived: true }
      })

      // Empty string means "not booked anywhere" — dropped, so the map holds
      // only real decisions and `destinationForMethod` refuses the rest.
      const methodDestinations = Object.fromEntries(
        Object.entries(data.methodDestinations).filter(([, code]) => Boolean(code)),
      )

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          paymentConfig: {
            ...existing,
            destinations: [...data.destinations, ...survivors],
            methodDestinations,
          } as unknown as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        before: {
          destinations: existing.destinations ?? [],
          methodDestinations: existing.methodDestinations ?? {},
        },
        after: { destinations: data.destinations, methodDestinations },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/cashier')
      revalidatePath('/cashier/pos')
      return { id: user.restaurantId }
    },
    'Payment destinations saved.',
  )
}

/**
 * Which rows a printed bill shows (bill.md §1).
 *
 * Its own action writing its own column, deliberately: the paper-width form
 * next to it writes `printerConfig`, and keeping them apart is what makes it
 * impossible for one to erase the other.
 */
export async function updateReceiptFields(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    receiptFieldsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      const { logoUrl, ...fields } = data

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          receiptConfig: fields as unknown as Prisma.InputJsonValue,
          // Only when the form sent one, so saving the toggles never clears a
          // logo the owner set on the profile tab.
          ...(logoUrl === undefined ? {} : { logoUrl: logoUrl || null }),
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { receipt: fields, logoUrl: logoUrl ?? null },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/cashier')
      revalidatePath('/cashier/pos')
      return { id: user.restaurantId }
    },
    'Bill settings saved.',
  )
}

export async function updatePrinterSettings(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    printerSettingsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)

      // Merged, for the same reason `updatePaymentSettings` above is: a form
      // owns its own keys and has no business deleting the rest of the column.
      const storedPrinter = (await prisma.restaurant.findUniqueOrThrow({
        where: { id: user.restaurantId },
        select: { printerConfig: true },
      })).printerConfig
      const basePrinter =
        storedPrinter && typeof storedPrinter === 'object' && !Array.isArray(storedPrinter)
          ? (storedPrinter as Record<string, unknown>)
          : {}

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          printerConfig: {
            ...basePrinter,
            receipt: { width: data.receiptWidth },
            kitchen: { width: data.kitchenWidth },
          } as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { printer: { receipt: data.receiptWidth, kitchen: data.kitchenWidth } },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/cashier')
      revalidatePath('/cashier/pos')
      revalidatePath('/kitchen')
      return { id: user.restaurantId }
    },
    'Printer settings saved.',
  )
}

/**
 * The cash controls: variance review, petty cash approval, and the till gate.
 *
 * They live in the same `approvalPolicy` JSON as the refund and discount
 * thresholds, because they answer the same question — how much is worth a
 * second pair of eyes — and an owner should find all of it in one place. This
 * is also the first UI that column has ever had; the four approval thresholds
 * have been configurable in the database and nowhere else.
 *
 * Merged rather than overwritten, so saving this form cannot silently reset the
 * refund threshold to its default.
 */
export async function updateCashControls(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    cashControlsSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      const restaurant = await requireRestaurant(user.restaurantId)
      const factor = minorUnitFactor(restaurant.currency)

      const existing = await getApprovalPolicy(user.restaurantId)
      const next = {
        ...existing,
        cashVarianceAbove: Math.round(data.cashVarianceAbove * factor),
        pettyCashApprovalAbove: Math.round(data.pettyCashApprovalAbove * factor),
        requireCashierSession: data.requireCashierSession,
      }

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: { approvalPolicy: next as unknown as Prisma.InputJsonValue },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: {
          cashVarianceAbove: next.cashVarianceAbove,
          pettyCashApprovalAbove: next.pettyCashApprovalAbove,
          requireCashierSession: next.requireCashierSession,
        },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/dashboard/cash-drawer')
      revalidatePath('/dashboard/petty-cash')
      return { id: user.restaurantId }
    },
    'Cash controls saved.',
  )
}

/**
 * The live floor board's thresholds.
 *
 * Merged over what is stored rather than written wholesale, for the same reason
 * `updateCashControls` above does it: saving this form must not silently reset
 * a field that was added to the policy after this form was last opened.
 */
export async function updateLiveBoardPolicy(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    liveBoardPolicySchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      const restaurant = await requireRestaurant(user.restaurantId)
      const factor = minorUnitFactor(restaurant.currency)

      const existing = await getLiveBoardPolicy(user.restaurantId)
      const next = {
        ...existing,
        ...data,
        // Typed in whole currency, stored in minor units like every other
        // amount in the schema.
        vipAfterSpend: Math.round(data.vipAfterSpend * factor),
      }

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: { liveBoardPolicy: next as unknown as Prisma.InputJsonValue },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { liveBoard: next },
      })

      revalidatePath('/dashboard/settings')
      revalidatePath('/dashboard/live')
      return { id: user.restaurantId }
    },
    'Live floor settings saved.',
  )
}

/**
 * Save how guests are met (ar.md §13, §19).
 *
 * Merged over what is stored rather than written wholesale, the same way the
 * live-board policy is: a form that posts only the fields it knows about must
 * not erase the ones a later version added.
 */
export async function updateGuestAppearance(input: unknown): Promise<ActionResult<{ ok: true }>> {
  return runAction(
    guestAppearanceSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      // Read the column itself: `requireRestaurant` returns the public summary,
      // which deliberately does not carry every settings blob.
      const stored = await prisma.restaurant.findUniqueOrThrow({
        where: { id: user.restaurantId },
        select: { guestExperience: true },
      })

      const existing = readAppearance(stored.guestExperience)
      const next = { ...existing, ...data }

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: { guestExperience: next as unknown as Prisma.InputJsonValue },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SETTINGS_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        after: { guestExperience: next },
      })

      /*
       * Both guest trees, because both read this one setting: the ordinary
       * table QR at `/order` and every QR menu at `/m`.
       */
      revalidatePath('/order', 'layout')
      revalidatePath('/m', 'layout')
      revalidatePath('/dashboard/settings/guest')
      return { ok: true as const }
    },
    'Guest experience saved.',
    'settings.guestAppearance',
  )
}

// ── SMS ──────────────────────────────────────────────────────────────────────

/**
 * Save a shop's own gateway.
 *
 * Three things here are not ceremony:
 *
 *  1. An empty credential means LEAVE UNCHANGED. Without that rule an owner
 *     cannot correct their sender mask without re-typing an API key they no
 *     longer have to hand, and the write-only field becomes infuriating.
 *  2. Changing anything that affects delivery clears `verifiedAt`. A gateway
 *     proven on Tuesday is not proven after its key is replaced on Friday, and
 *     a stale tick beside a dead gateway is worse than no tick at all.
 *  3. The audit row records which credential SLOTS changed, by name, and never
 *     the values. `REDACTED_KEYS` would also catch them; this is the first line
 *     of defence rather than the second.
 */
export async function updateSmsConfig(input: unknown): Promise<ActionResult<{ id: string }>> {
  return runAction(
    smsConfigSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      const restaurant = await requireRestaurant(user.restaurantId)
      const existing = await readSmsConfig(user.restaurantId)

      const { credentials, hints, changed } = mergeCredentials(existing, data.credentials)
      const spec = specFromInput(data)

      /* An owner-supplied URL is a request the server will make. Check it now,
       * at the one moment there is a human waiting to read the reason. */
      if (spec?.url) {
        const unknown = unknownTokensIn(spec)
        if (unknown.length > 0) {
          throw new ValidationError('That template uses a placeholder we do not recognise', {
            'spec.bodyTemplate': [
              `Unknown placeholder${unknown.length > 1 ? 's' : ''}: ${unknown.map((t) => `{${t}}`).join(', ')}`,
            ],
          })
        }
        await assertSafeGatewayUrl(spec.url, await gatewayHostAllowlist())
      }

      /*
       * What invalidates a proof. A changed sender mask does not: the same
       * gateway with a different mask still answers, and re-testing for a
       * typo in a label would train owners to click through the test.
       */
      const deliveryChanged =
        changed.length > 0 ||
        data.provider !== existing.provider ||
        JSON.stringify(spec) !== JSON.stringify(existing.spec)

      const verifiedAt = deliveryChanged ? null : existing.verifiedAt

      const anyTrigger = Object.values(data.triggers).some(Boolean)
      if (anyTrigger && !verifiedAt) {
        throw new ValidationError('Send a test message before switching any messages on', {
          triggers: [
            deliveryChanged
              ? 'The gateway details changed, so it needs testing again before messages can go out'
              : 'Send a test message first, so we know the gateway works',
          ],
        })
      }

      const factor = minorUnitFactor(data.costCurrency || restaurant.currency)
      const next: SmsConfig = {
        ...existing,
        enabled: data.enabled,
        provider: data.provider,
        senderId: data.senderId,
        senderIdApproved: data.senderIdApproved,
        verifiedAt,
        defaultCountry: 'LK',
        spec,
        credentials,
        credentialHints: hints,
        caps: data.caps,
        costMinor: data.cost === null || data.cost === undefined ? null : Math.round(data.cost * factor),
        costCurrency: data.costCurrency || restaurant.currency,
        triggers: data.triggers,
        templates: data.templates,
        trialOnlyVerified: data.trialOnlyVerified,
        verifiedRecipients: splitNumbers(data.verifiedRecipients),
        optOut: splitNumbers(data.optOut),
      }

      /* Switching gateway leaves the old one's credential slots behind. */
      const pruned = pruneCredentials(next)
      next.credentials = pruned.credentials
      next.credentialHints = pruned.hints

      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: { smsConfig: next as unknown as Prisma.InputJsonValue },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SMS_CONFIG_UPDATED,
        entity: 'Restaurant',
        entityId: user.restaurantId,
        // Names of what changed, never values. See the note above.
        after: {
          provider: next.provider,
          senderId: next.senderId,
          enabled: next.enabled,
          credentialsChanged: changed,
          verifiedCleared: deliveryChanged && Boolean(existing.verifiedAt),
          triggers: next.triggers,
        },
      })

      revalidatePath('/dashboard/settings')
      return { id: user.restaurantId }
    },
    'SMS settings saved.',
    'updateSmsConfig',
  )
}

export interface SmsTestOutcome {
  sent: boolean
  dialled: string
  segments: number
  encoding: string
  providerMessageId: string | null
  error?: string
  errorCode?: string
}

/**
 * Send one real message to one real phone, and record whether it arrived.
 *
 * The whole point of the feature's first phase. It spends one of the owner's
 * own credits, which is why it is rate limited, and it is the only thing that
 * sets `verifiedAt` — no trigger may fire until this has worked once.
 */
export async function sendTestSms(input: unknown): Promise<ActionResult<SmsTestOutcome>> {
  return runAction(
    smsTestSchema,
    input,
    async (data) => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      await enforceRateLimit('smsTest', user.restaurantId)

      const config = await readSmsConfig(user.restaurantId)
      if (!resolveFrom(config)) {
        throw new ValidationError('Fill in the gateway details and save before sending a test', {
          _root: ['No SMS gateway is configured yet'],
        })
      }

      const result = await sendSms({
        restaurantId: user.restaurantId,
        to: data.to,
        text: data.message,
        purpose: 'TEST',
        requestedById: user.id,
        config,
      })

      const row = result.messageId
        ? await prisma.smsMessage.findUnique({
            where: { id: result.messageId },
            select: { toE164: true, segments: true, encoding: true, providerMessageId: true },
          })
        : null

      /*
       * Stamped on success, cleared on failure. A gateway that stopped working
       * should lock its own triggers rather than keep firing into the dark.
       */
      await prisma.restaurant.update({
        where: { id: user.restaurantId },
        data: {
          smsConfig: {
            ...config,
            verifiedAt: result.sent ? new Date().toISOString() : null,
          } as unknown as Prisma.InputJsonValue,
        },
      })

      await audit({
        restaurantId: user.restaurantId,
        userId: user.id,
        actorName: user.name,
        action: AUDIT_ACTIONS.SMS_TEST_SENT,
        entity: 'SmsMessage',
        entityId: result.messageId,
        after: { sent: result.sent, provider: config.provider, errorCode: result.errorCode ?? null },
      })

      revalidatePath('/dashboard/settings')

      return {
        sent: result.sent,
        dialled: row?.toE164 ?? data.to,
        segments: row?.segments ?? 1,
        encoding: row?.encoding ?? 'GSM7',
        providerMessageId: row?.providerMessageId ?? null,
        error: result.error,
        errorCode: result.errorCode,
      }
    },
    undefined,
    'sendTestSms',
  )
}

/** One number per line in, `phoneKey` form out. */
function splitNumbers(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/[\n,;]/)
        .map((entry) => phoneKey(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ]
}

/** Flatten the form's spec fields into the stored shape, or null for a preset. */
function specFromInput(data: SmsConfigInput): HttpGatewaySpec | null {
  const spec = data.spec
  if (!spec || !spec.url) return null

  const success =
    spec.successKind === 'jsonEquals'
      ? {
          kind: 'jsonEquals' as const,
          path: spec.successPath ?? 'status',
          equals: (spec.successEquals ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
        }
      : spec.successKind === 'jsonTruthy'
        ? { kind: 'jsonTruthy' as const, path: spec.successPath ?? 'id' }
        : spec.successKind === 'bodyContains'
          ? { kind: 'bodyContains' as const, needle: spec.successNeedle ?? 'OK' }
          : { kind: 'httpStatus' as const }

  return {
    method: spec.method,
    url: spec.url,
    headers: spec.headers ?? {},
    bodyEncoding: spec.bodyEncoding,
    bodyTemplate: spec.bodyTemplate ?? '',
    auth:
      spec.authMode === 'header'
        ? { mode: 'header', header: spec.authHeader ?? 'X-API-Key' }
        : { mode: spec.authMode },
    success,
    messageIdPath: spec.messageIdPath || undefined,
    errorMessagePath: spec.errorMessagePath || undefined,
    errorCodePath: spec.errorCodePath || undefined,
    numberFormat: spec.numberFormat,
    encoding: spec.encoding,
    unicodeField: spec.unicodeFieldName
      ? {
          name: spec.unicodeFieldName,
          gsm7Value: spec.unicodeGsm7Value ?? 'plain',
          unicodeValue: spec.unicodeValue ?? 'unicode',
        }
      : undefined,
  }
}

export interface SmsRequestPreview {
  method: string
  url: string
  headers: Record<string, string>
  body: string | null
  dialled: string
}

/**
 * The exact request that will go out, with credentials masked.
 *
 * The highest-value panel on the page. Recipient format, sender mask and the
 * success rule are the three settings that fail silently — a gateway handed
 * the wrong number shape accepts it, bills for it and drops it — and this is
 * the one place an owner can see all three before spending a credit.
 *
 * A server action rather than client-side assembly because building the
 * request needs the decrypted credentials, and the whole design turns on those
 * never reaching a browser. What comes back is already masked.
 */
export async function previewSmsRequest(to: string): Promise<ActionResult<SmsRequestPreview>> {
  return runSafe(
    async () => {
      const user = await requirePermission(PERMISSIONS.SETTINGS_MANAGE)
      const config = await readSmsConfig(user.restaurantId)
      const resolved = resolveFrom(config)
      if (!resolved) throw new ValidationError('No gateway is configured yet', {})

      const country = countryFor(config)
      const number = toE164(to, country)
      if (!number.ok) {
        throw new ValidationError(E164_FAILURE_MESSAGE[number.reason], { to: [E164_FAILURE_MESSAGE[number.reason]] })
      }

      const prepared = prepareRequest(
        resolved,
        {
          to: number.e164,
          text: config.templates.receipt || 'Test message from your restaurant.',
          sender: config.senderId || undefined,
          reference: 'preview',
        },
        country,
        { maskCredentials: true },
      )

      return {
        method: prepared.method,
        url: prepared.url,
        headers: prepared.headers,
        body: prepared.body ?? null,
        dialled: prepared.dialled,
      }
    },
    undefined,
    'previewSmsRequest',
  )
}
