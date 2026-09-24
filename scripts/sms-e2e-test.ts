/**
 * The whole SMS path, against a gateway that costs nothing.
 *
 * `sms-test.ts` proves the pieces in isolation. This proves they are wired
 * together: a real tenant row, a real config, a real HTTP request through the
 * SSRF guard, a real `sms_messages` row with the right status on it.
 *
 * ── It borrows a tenant and gives it back ───────────────────────────────────
 *
 * There is no fixture restaurant, so this takes the first one, remembers its
 * `smsConfig`, and restores it in a `finally` along with deleting every row it
 * created. A verification script that leaves a shop pointed at a fake gateway
 * would be a worse bug than the ones it is looking for.
 *
 * Needs the fake gateway running:
 *   node scripts/fake-sms-gateway.mjs
 *   npx tsx --tsconfig tsconfig.test.json scripts/sms-e2e-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { sendSms } from '../src/server/sms/send'
import { mergeSmsConfig } from '../src/features/sms/config'
import { sealSecret } from '../src/server/crypto/secret-box'
import type { HttpGatewaySpec, SmsConfig } from '../src/features/sms/types'

const GATEWAY = process.env.FAKE_SMS_URL ?? 'http://localhost:4545'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const specFor = (path: string): HttpGatewaySpec => ({
  method: 'POST',
  url: `${GATEWAY}${path}`,
  headers: {},
  bodyEncoding: 'form',
  bodyTemplate: 'api_key={apiKey}&sender_id={sender}&to={to}&message={text}',
  auth: { mode: 'field' },
  success: { kind: 'jsonEquals', path: 'status', equals: ['success'] },
  messageIdPath: 'data.id',
  errorMessagePath: 'message',
  numberFormat: 'e164NoPlus',
  encoding: 'auto',
})

function configWith(spec: HttpGatewaySpec, overrides: Partial<SmsConfig> = {}): SmsConfig {
  return mergeSmsConfig({
    enabled: true,
    provider: 'custom',
    senderId: 'TESTMASK',
    senderIdApproved: true,
    verifiedAt: new Date().toISOString(),
    spec,
    credentials: { apiKey: sealSecret('fake-key', 'sms') },
    credentialHints: { apiKey: 'key' },
    triggers: {
      otp: true,
      receipt: true,
      orderReady: true,
      reservationConfirm: true,
      reservationReminder: true,
      marketing: false,
    },
    ...overrides,
  })
}

async function main() {
  process.env.CREDENTIAL_ENCRYPTION_KEY ||= 'test-key-that-is-at-least-32-chars-long'

  /* Fail fast and clearly rather than reporting nine mysterious failures. */
  try {
    const probe = await fetch(`${GATEWAY}/send`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
    })
    if (!probe.ok) throw new Error(String(probe.status))
  } catch {
    console.error(`\nThe fake gateway is not answering on ${GATEWAY}.`)
    console.error('Start it first:  node scripts/fake-sms-gateway.mjs\n')
    process.exit(1)
  }

  const restaurant = await prisma.restaurant.findFirstOrThrow({
    select: { id: true, name: true, smsConfig: true },
    orderBy: { createdAt: 'asc' },
  })
  const originalConfig = restaurant.smsConfig
  const created: string[] = []

  console.log(`\nBorrowing "${restaurant.name}" — its settings are restored at the end.\n`)

  try {
    const set = async (config: SmsConfig) => {
      await prisma.restaurant.update({
        where: { id: restaurant.id },
        data: { smsConfig: config as never },
      })
      return config
    }

    console.log('1. A message that goes through')
    {
      const config = await set(configWith(specFor('/send')))
      const result = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Your table is ready.',
        purpose: 'ORDER_STATUS',
        trigger: 'orderReady',
        config,
      })
      if (result.messageId) created.push(result.messageId)

      check('it reports sent', result.sent, result.error)
      check('the status is SENT', result.status === 'SENT')

      const row = result.messageId
        ? await prisma.smsMessage.findUnique({ where: { id: result.messageId } })
        : null
      check('a row was written', Boolean(row))
      check('with the dialled number', row?.toE164 === '+94771234567')
      check('and what the human typed', row?.toRaw === '0771234567')
      check('the gateway id came back', Boolean(row?.providerMessageId))
      check('sentAt is stamped', Boolean(row?.sentAt))
      check('one segment, GSM-7', row?.segments === 1 && row?.encoding === 'GSM7')
      check('the body is kept for a non-OTP message', row?.body === 'Your table is ready.')
    }

    console.log('\n2. An OTP never has its digits written down')
    {
      const config = await set(configWith(specFor('/send')))
      const result = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Your code is 481920.',
        purpose: 'OTP',
        config,
      })
      if (result.messageId) created.push(result.messageId)

      check('it sends', result.sent, result.error)
      const row = result.messageId
        ? await prisma.smsMessage.findUnique({ where: { id: result.messageId } })
        : null
      check('the body column is NULL', row?.body === null)

      const leaked = await prisma.smsMessage.count({
        where: { restaurantId: restaurant.id, body: { contains: '481920' } },
      })
      check('the code appears nowhere in the table', leaked === 0)
    }

    console.log('\n3. HTTP 200 with an error body is a failure, not a success')
    {
      const config = await set(configWith(specFor('/fail')))
      const result = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'This should fail.',
        purpose: 'RECEIPT',
        trigger: 'receipt',
        config,
      })
      if (result.messageId) created.push(result.messageId)

      check('it reports not sent', !result.sent)
      check('the status is FAILED', result.status === 'FAILED')
      check('no credit is recognised by name', result.errorCode === 'INSUFFICIENT_CREDIT', result.errorCode)
      check("the gateway's own words reach the owner", result.error === 'insufficient credit', result.error)
    }

    console.log('\n4. A redirect is refused rather than followed')
    {
      const config = await set(configWith(specFor('/redirect')))
      const result = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Follow me to the metadata service.',
        purpose: 'RECEIPT',
        trigger: 'receipt',
        config,
      })
      if (result.messageId) created.push(result.messageId)

      check('it did not go', !result.sent)
      check('and it is not retried', result.errorCode === 'URL_REFUSED', result.errorCode)
    }

    console.log('\n5. Refusals are recorded, never silent')
    {
      const off = await set(configWith(specFor('/send'), { enabled: false }))
      const result = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Should not go.',
        purpose: 'RECEIPT',
        trigger: 'receipt',
        config: off,
      })
      if (result.messageId) created.push(result.messageId)
      check('a disabled tenant yields SUPPRESSED', result.status === 'SUPPRESSED')
      check('with a reason attached', result.errorCode === 'TENANT_DISABLED', result.errorCode)

      const triggerOff = await set(
        configWith(specFor('/send'), {
          triggers: {
            otp: true,
            receipt: false,
            orderReady: true,
            reservationConfirm: true,
            reservationReminder: true,
            marketing: false,
          },
        }),
      )
      const second = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Receipts are off.',
        purpose: 'RECEIPT',
        trigger: 'receipt',
        config: triggerOff,
      })
      if (second.messageId) created.push(second.messageId)
      check('a switched-off trigger yields SUPPRESSED', second.status === 'SUPPRESSED')
      check('named as such', second.errorCode === 'TRIGGER_OFF', second.errorCode)

      const unresolvable = await sendSms({
        restaurantId: restaurant.id,
        to: '771234567',
        text: 'No country code.',
        purpose: 'ORDER_STATUS',
        trigger: 'orderReady',
        config: await set(configWith(specFor('/send'))),
      })
      if (unresolvable.messageId) created.push(unresolvable.messageId)
      check('an ambiguous number is refused, not guessed', unresolvable.status === 'SUPPRESSED')
      check('and says why', unresolvable.errorCode === 'BAD_NUMBER_AMBIGUOUS', unresolvable.errorCode)
    }

    console.log('\n6. The same trigger twice sends one message')
    {
      const config = await set(configWith(specFor('/send')))
      const key = `e2e-dedupe:${Date.now()}`

      const first = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Order 17 is ready.',
        purpose: 'ORDER_STATUS',
        trigger: 'orderReady',
        dedupeKey: key,
        config,
      })
      const second = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Order 17 is ready.',
        purpose: 'ORDER_STATUS',
        trigger: 'orderReady',
        dedupeKey: key,
        config,
      })
      if (first.messageId) created.push(first.messageId)
      if (second.messageId && second.messageId !== first.messageId) created.push(second.messageId)

      check('the first goes', first.sent, first.error)
      check('the second resolves to the same row', second.messageId === first.messageId)

      const rows = await prisma.smsMessage.count({ where: { dedupeKey: key } })
      check('and only one row exists', rows === 1)
    }

    console.log('\n7. A trial account reaches only its verified list')
    {
      const config = await set(
        configWith(specFor('/send'), {
          trialOnlyVerified: true,
          verifiedRecipients: ['94770000000'],
        }),
      )
      const result = await sendSms({
        restaurantId: restaurant.id,
        to: '0771234567',
        text: 'Not on the list.',
        purpose: 'ORDER_STATUS',
        trigger: 'orderReady',
        config,
      })
      if (result.messageId) created.push(result.messageId)

      check('an unlisted number is suppressed before a credit is spent', result.status === 'SUPPRESSED')
      check('named so it can be diagnosed', result.errorCode === 'NUMBER_NOT_VERIFIED', result.errorCode)
    }
  } finally {
    if (created.length > 0) {
      await prisma.smsMessage.deleteMany({ where: { id: { in: created } } })
    }
    await prisma.restaurant.update({
      where: { id: restaurant.id },
      data: { smsConfig: (originalConfig ?? null) as never },
    })
    console.log(`\nRestored "${restaurant.name}" and removed ${created.length} test rows.`)
    await prisma.$disconnect()
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
