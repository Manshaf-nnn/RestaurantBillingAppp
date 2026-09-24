import 'server-only'

import type { Prisma, SmsPurpose, SmsStatus } from '@prisma/client'

import { prisma } from '@/server/db/prisma'
import { phoneKey } from '@/features/customers/phone'
import { startOfDay } from '@/features/reports/range'
import { countSegments } from '@/features/sms/encoding'
import { sendViaHttp } from '@/features/sms/http-adapter'
import { toE164, maskNumber, E164_FAILURE_MESSAGE } from '@/features/sms/msisdn'
import {
  countryFor,
  gatewayHostAllowlist,
  isPlatformSmsDisabled,
  readSmsConfig,
  resolveFrom,
} from '@/features/sms/config'
import type { SmsConfig, SmsTriggerKey } from '@/features/sms/types'

/**
 * One way out of this product and onto somebody's phone.
 *
 * ── The contract, copied from sendMail ──────────────────────────────────────
 *
 * Returns `{ sent }` and NEVER throws. `src/server/mailer.ts` established this
 * and the reason is the same here, only sharper: the callers are a payment
 * being captured and an order changing status. A gateway that is out of credit
 * must not roll back a settled bill, so every failure is a return value.
 *
 * ── Every refusal is recorded ───────────────────────────────────────────────
 *
 * A cap, a kill switch, an opt-out or an unresolvable number produces a
 * SUPPRESSED row with a reason rather than an early `return`. "The texts
 * stopped and nobody can say why" is the failure this whole table exists to
 * prevent, and a silent branch is exactly how that happens.
 *
 * ── What it does not print ──────────────────────────────────────────────────
 *
 * `sendMail` logs the whole message when SMTP is unconfigured, which is a good
 * affordance for a password-reset link. It would be a terrible one for an OTP,
 * so this logs the shape of an OTP and never its digits.
 */

export interface SendSmsInput {
  restaurantId: string
  branchId?: string | null
  /** As a human typed it. Resolved to E.164 here, not by the caller. */
  to: string
  text: string
  purpose: SmsPurpose
  /** Which trigger toggle governs this send. Omitted for TEST and OTP. */
  trigger?: SmsTriggerKey
  /** Idempotency: `order-ready:<orderId>`. A second call with it is a no-op. */
  dedupeKey?: string
  entity?: string
  entityId?: string
  requestedById?: string
  /** Set when the caller has already loaded the config, to save a query. */
  config?: SmsConfig
}

export interface SendSmsResult {
  sent: boolean
  /** Null only when the row itself could not be written. */
  messageId: string | null
  status: SmsStatus
  /** Safe to show a member of staff. Never contains a credential. */
  error?: string
  errorCode?: string
}

/** A refusal: recorded, reported, and never retried. */
async function suppress(
  input: SendSmsInput,
  provider: string,
  errorCode: string,
  errorMessage: string,
  e164: string,
): Promise<SendSmsResult> {
  const segments = countSegments(input.text)
  const row = await prisma.smsMessage.create({
    data: {
      restaurantId: input.restaurantId,
      branchId: input.branchId ?? null,
      purpose: input.purpose,
      status: 'SUPPRESSED',
      provider,
      toE164: e164,
      toRaw: input.to,
      body: bodyFor(input),
      segments: segments.segments,
      encoding: segments.alphabet,
      errorCode,
      errorMessage,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      requestedById: input.requestedById ?? null,
      dedupeKey: input.dedupeKey ?? null,
    },
    select: { id: true },
  })

  return { sent: false, messageId: row.id, status: 'SUPPRESSED', error: errorMessage, errorCode }
}

/**
 * The stored body, or null for a code.
 *
 * The single rule that keeps this table safe to read: an OTP's digits are
 * never written down. A support engineer looking at a delivery log must not be
 * able to sign in as a guest, and a nightly backup must not be a list of live
 * codes waiting five minutes each.
 */
const bodyFor = (input: SendSmsInput): string | null =>
  input.purpose === 'OTP' ? null : input.text

export async function sendSms(input: SendSmsInput): Promise<SendSmsResult> {
  const config = input.config ?? (await readSmsConfig(input.restaurantId))
  const provider = config.provider

  try {
    // 1 — the operator's global stop, checked before anything tenant-owned.
    if (await isPlatformSmsDisabled()) {
      return suppress(input, provider, 'PLATFORM_DISABLED', 'SMS is disabled platform-wide', input.to)
    }

    /*
     * A test send is the act that PROVES the configuration, so it cannot
     * require the proof as a precondition — checks 2 to 4 would make the
     * button that sets `verifiedAt` refuse to run until `verifiedAt` was set.
     * It still passes every other gate below: the SSRF guard, number
     * resolution, the trial list and the caps all apply, because a test
     * spends a real credit and reaches a real phone.
     */
    const isTest = input.purpose === 'TEST'

    // 2 — the owner's own switch.
    if (!isTest && !config.enabled) {
      return suppress(input, provider, 'TENANT_DISABLED', 'SMS is switched off for this restaurant', input.to)
    }

    // 3 — the per-event toggle. Configuring a gateway is not agreeing to use it.
    if (!isTest && input.trigger && !config.triggers[input.trigger]) {
      return suppress(
        input,
        provider,
        'TRIGGER_OFF',
        `The "${input.trigger}" SMS trigger is switched off`,
        input.to,
      )
    }

    // 4 — a half-filled form is not a tenant who agreed to text their guests.
    if (!isTest && !config.verifiedAt) {
      return suppress(
        input,
        provider,
        'NOT_VERIFIED',
        'Send a test SMS from Settings before switching triggers on',
        input.to,
      )
    }

    // 5 — the number we were given, resolved or refused.
    const country = countryFor(config)
    const resolvedNumber = toE164(input.to, country)
    if (!resolvedNumber.ok) {
      return suppress(
        input,
        provider,
        `BAD_NUMBER_${resolvedNumber.reason}`,
        E164_FAILURE_MESSAGE[resolvedNumber.reason],
        input.to,
      )
    }
    const e164 = resolvedNumber.e164
    const key = phoneKey(e164) ?? ''

    // 6 — somebody who asked to stop.
    if (config.optOut.includes(key)) {
      return suppress(input, provider, 'OPTED_OUT', 'This number has opted out of messages', e164)
    }

    /*
     * 7 — a trial account only reaches its verified list, and does not say so:
     * it accepts everything and delivers to nobody else. Without this check the
     * symptom is "it works on the owner's phone and for no guest", which is a
     * week of debugging the wrong thing.
     */
    if (config.trialOnlyVerified && !config.verifiedRecipients.includes(key)) {
      return suppress(
        input,
        provider,
        'NUMBER_NOT_VERIFIED',
        'This gateway is in trial mode and only delivers to its verified numbers',
        e164,
      )
    }

    // 8 — the caps, counted in Postgres. See the note on countToday.
    const capFailure = await checkCaps(input, config, e164)
    if (capFailure) return suppress(input, provider, capFailure.code, capFailure.message, e164)

    // 9 — the gateway itself.
    const resolved = resolveFrom(config)
    if (!resolved) {
      return suppress(
        input,
        provider,
        'NOT_CONFIGURED',
        'This restaurant has no SMS gateway configured',
        e164,
      )
    }

    const segments = countSegments(input.text, resolved.spec.encoding)

    /*
     * The row is written BEFORE the request goes out, so a process that dies
     * mid-flight leaves evidence that something was attempted. `dedupeKey` is
     * unique, so a duplicate trigger loses the race here rather than at the
     * gateway — the same mechanism `enqueue()` uses in the job runner.
     */
    let message: { id: string }
    try {
      message = await prisma.smsMessage.create({
        data: {
          restaurantId: input.restaurantId,
          branchId: input.branchId ?? null,
          purpose: input.purpose,
          status: 'SENDING',
          provider,
          toE164: e164,
          toRaw: input.to,
          senderId: config.senderId || null,
          body: bodyFor(input),
          segments: segments.segments,
          encoding: segments.alphabet,
          costMinor: config.costMinor === null ? null : config.costMinor * segments.segments,
          entity: input.entity ?? null,
          entityId: input.entityId ?? null,
          requestedById: input.requestedById ?? null,
          dedupeKey: input.dedupeKey ?? null,
        },
        select: { id: true },
      })
    } catch (error) {
      if (isUniqueViolation(error)) {
        /* Somebody already sent this exact thing. That is a success, not a fault. */
        const existing = await prisma.smsMessage.findUnique({
          where: { dedupeKey: input.dedupeKey! },
          select: { id: true, status: true },
        })
        return {
          sent: existing?.status === 'SENT' || existing?.status === 'DELIVERED',
          messageId: existing?.id ?? null,
          status: existing?.status ?? 'QUEUED',
        }
      }
      throw error
    }

    const allowlist = await gatewayHostAllowlist()
    const outcome = await sendViaHttp(
      resolved,
      { to: e164, text: input.text, sender: config.senderId || undefined, reference: message.id },
      country,
      allowlist,
    )

    if (outcome.ok) {
      await prisma.smsMessage.update({
        where: { id: message.id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          attempts: { increment: 1 },
          providerMessageId: outcome.providerMessageId,
          rawResponse: outcome.raw || null,
        },
      })
      return { sent: true, messageId: message.id, status: 'SENT' }
    }

    await prisma.smsMessage.update({
      where: { id: message.id },
      data: {
        status: 'FAILED',
        attempts: { increment: 1 },
        errorCode: outcome.code,
        errorMessage: outcome.message,
        rawResponse: outcome.raw || null,
      },
    })

    return {
      sent: false,
      messageId: message.id,
      status: 'FAILED',
      error: outcome.message,
      errorCode: outcome.code,
    }
  } catch (error) {
    /*
     * Last resort. Reaching here means the delivery log itself is unavailable,
     * and the caller is still a payment that must complete. Log the shape and
     * let the business operation finish.
     */
    console.error('[sms] send failed', {
      restaurantId: input.restaurantId,
      purpose: input.purpose,
      to: maskNumber(input.to),
      error: error instanceof Error ? error.message : String(error),
    })
    return {
      sent: false,
      messageId: null,
      status: 'FAILED',
      error: 'The message could not be sent',
      errorCode: 'INTERNAL',
    }
  }
}

// ── Caps ─────────────────────────────────────────────────────────────────────

/**
 * Counted in Postgres, not Redis.
 *
 * `incrementCounter` falls back to a per-process Map when Redis is absent,
 * which on a serverless host means every cold start gets a fresh allowance —
 * a cap that resets when you look at it is not a cap. The indexes on
 * `sms_messages` exist to make these counts cheap.
 *
 * The day boundary is the restaurant's own: "today" for a Colombo kitchen is
 * not UTC today, and a cap that rolls over at 5:30am local is a cap that
 * expires mid-dinner-service.
 */
async function checkCaps(
  input: SendSmsInput,
  config: SmsConfig,
  e164: string,
): Promise<{ code: string; message: string } | null> {
  const restaurant = await prisma.restaurant.findUnique({
    where: { id: input.restaurantId },
    select: { timezone: true },
  })
  const since = startOfDay(new Date(), restaurant?.timezone ?? 'Asia/Colombo')

  /* SUPPRESSED rows are excluded: a refusal cost nothing and must not itself
   * consume the allowance, or one misconfigured trigger exhausts the day. */
  const billable: SmsStatus[] = ['QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'UNDELIVERED', 'FAILED']

  const [today, toRecipient] = await Promise.all([
    prisma.smsMessage.count({
      where: { restaurantId: input.restaurantId, createdAt: { gte: since }, status: { in: billable } },
    }),
    prisma.smsMessage.count({
      where: {
        restaurantId: input.restaurantId,
        toE164: e164,
        createdAt: { gte: since },
        status: { in: billable },
      },
    }),
  ])

  if (today >= config.caps.perDay) {
    return {
      code: 'CAP_DAILY',
      message: `This restaurant's daily SMS cap of ${config.caps.perDay} has been reached`,
    }
  }

  if (toRecipient >= config.caps.perRecipientPerDay) {
    return {
      code: 'CAP_RECIPIENT',
      message: `This number has already received ${config.caps.perRecipientPerDay} messages today`,
    }
  }

  if (input.purpose === 'OTP') {
    const hourAgo = new Date(Date.now() - 3_600_000)
    const codes = await prisma.smsMessage.count({
      where: {
        restaurantId: input.restaurantId,
        purpose: 'OTP',
        createdAt: { gte: hourAgo },
        status: { in: billable },
      },
    })
    if (codes >= config.caps.otpPerHour) {
      return { code: 'CAP_OTP_HOURLY', message: 'Too many verification codes have been sent this hour' }
    }
  }

  return null
}

const isUniqueViolation = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as Prisma.PrismaClientKnownRequestError).code === 'P2002'
