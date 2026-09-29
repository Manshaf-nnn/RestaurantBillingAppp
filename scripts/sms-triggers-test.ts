/**
 * The texts that go out by themselves, end to end through the real sender.
 *
 * Borrows the first restaurant's SMS settings, points them at the fake
 * gateway, fires each trigger the way the app does, and reads the delivery
 * log back. The settings are restored and every row this made is removed,
 * whatever happens.
 *
 * Needs the fake gateway running:
 *   node scripts/fake-sms-gateway.mjs
 *   npx tsx --tsconfig tsconfig.test.json scripts/sms-triggers-test.ts
 */

import type { Order, Reservation } from '@prisma/client'

import { prisma } from '../src/server/db/prisma'
import { mergeSmsConfig } from '../src/features/sms/config'
import type { HttpGatewaySpec, SmsConfig } from '../src/features/sms/types'
import { sealSecret } from '../src/server/crypto/secret-box'
import {
  sendReservationReminders,
  smsOrderPaid,
  smsOrderReady,
  smsReservationSaved,
} from '../src/server/sms/notify'

const GATEWAY = process.env.FAKE_SMS_URL ?? 'http://localhost:4545'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

const spec: HttpGatewaySpec = {
  method: 'POST',
  url: `${GATEWAY}/send`,
  headers: {},
  bodyEncoding: 'form',
  bodyTemplate: 'api_key={apiKey}&sender_id={sender}&to={to}&message={text}',
  auth: { mode: 'field' },
  success: { kind: 'jsonEquals', path: 'status', equals: ['success'] },
  messageIdPath: 'data.id',
  errorMessagePath: 'message',
  numberFormat: 'e164NoPlus',
  encoding: 'auto',
}

function configWith(overrides: Partial<SmsConfig> = {}): SmsConfig {
  return mergeSmsConfig({
    enabled: true,
    provider: 'custom',
    senderId: 'TESTMASK',
    senderIdApproved: true,
    // Deliberately never tested: switching a message on no longer needs it.
    verifiedAt: null,
    spec,
    credentials: { apiKey: sealSecret('fake-key', 'sms') },
    credentialHints: { apiKey: 'key' },
    triggers: {
      otp: false,
      receipt: true,
      orderReady: true,
      deliveryOnTheWay: true,
      reservationConfirm: true,
      reservationReminder: true,
      marketing: false,
    },
    templates: { receipt: 'Paid {total} for {order}, thanks {name} - {restaurant}' },
    ...overrides,
  })
}

async function main() {
  process.env.CREDENTIAL_ENCRYPTION_KEY ||= 'test-key-that-is-at-least-32-chars-long'

  try {
    const probe = await fetch(`${GATEWAY}/send`, { method: 'POST', signal: AbortSignal.timeout(2000) })
    if (!probe.ok) throw new Error(String(probe.status))
  } catch {
    console.error(`\nThe fake gateway is not answering on ${GATEWAY}.`)
    console.error('Start it first:  node scripts/fake-sms-gateway.mjs\n')
    process.exit(1)
  }

  const restaurant = await prisma.restaurant.findFirstOrThrow({
    select: { id: true, name: true, currency: true, smsConfig: true },
    orderBy: { createdAt: 'asc' },
  })
  const originalConfig = restaurant.smsConfig
  const stamp = Date.now().toString(36)
  const createdReservations: string[] = []

  console.log(`\nBorrowing "${restaurant.name}" — its settings are restored at the end.\n`)

  const setConfig = (config: SmsConfig) =>
    prisma.restaurant.update({ where: { id: restaurant.id }, data: { smsConfig: config as never } })

  const logFor = (entityId: string) =>
    prisma.smsMessage.findMany({ where: { restaurantId: restaurant.id, entityId }, orderBy: { createdAt: 'asc' } })

  /* A synthetic order: nothing here needs the row, only its fields. */
  const order = (over: Partial<Order>): Order =>
    ({
      id: `test-order-${stamp}`,
      restaurantId: restaurant.id,
      branchId: null,
      orderNumber: `T-${stamp.toUpperCase()}`,
      type: 'TAKEAWAY',
      status: 'READY',
      customerName: 'Nimal Perera',
      customerPhone: '0771234567',
      grandTotal: 125000,
      ...over,
    }) as Order

  try {
    await setConfig(configWith())

    console.log('1. The bill, once paid')
    const paid = order({ id: `test-paid-${stamp}` })
    await smsOrderPaid(paid, { name: restaurant.name, currency: restaurant.currency })
    let rows = await logFor(paid.id)
    check('one message was sent', rows.length === 1 && rows[0]!.status === 'SENT', rows.map((r) => r.status))
    check('to the guest, dialled properly', rows[0]?.toE164 === '+94771234567', rows[0]?.toE164)
    check('with the receipt purpose and trigger key', rows[0]?.purpose === 'RECEIPT' && rows[0]?.dedupeKey === `order-paid:${paid.id}`)
    check(
      "using the owner's wording with the blanks filled",
      rows[0]?.body?.startsWith('Paid ') === true &&
        rows[0]!.body!.includes(paid.orderNumber) &&
        rows[0]!.body!.includes('Nimal') &&
        rows[0]!.body!.includes(restaurant.name),
      rows[0]?.body,
    )
    await smsOrderPaid(paid, { name: restaurant.name, currency: restaurant.currency })
    rows = await logFor(paid.id)
    check('settling the same bill again sends nothing more', rows.length === 1, rows.length)

    console.log('\n2. Ready, for a takeaway')
    const ready = order({ id: `test-ready-${stamp}` })
    await smsOrderReady(ready)
    rows = await logFor(ready.id)
    check('sent with the standard wording', rows.length === 1 && rows[0]!.body?.includes('is ready') === true, rows[0]?.body)
    check('logged as an order status message', rows[0]?.purpose === 'ORDER_STATUS')

    console.log('\n3. Ready, for a delivery')
    const delivery = order({ id: `test-delivery-${stamp}`, type: 'DELIVERY' })
    await smsOrderReady(delivery)
    rows = await logFor(delivery.id)
    check('says it is on its way, not ready', rows.length === 1 && rows[0]!.body?.includes('on its way') === true, rows[0]?.body)

    console.log('\n4. A delivery with that message switched off')
    await setConfig(configWith({ triggers: { ...configWith().triggers, deliveryOnTheWay: false } }))
    const quiet = order({ id: `test-quiet-${stamp}`, type: 'DELIVERY' })
    await smsOrderReady(quiet)
    rows = await logFor(quiet.id)
    check('writes nothing at all — not even a suppressed row', rows.length === 0, rows.length)
    await setConfig(configWith())

    console.log('\n5. A guest with no number')
    const nobody = order({ id: `test-nobody-${stamp}`, customerPhone: '' })
    await smsOrderReady(nobody)
    rows = await logFor(nobody.id)
    check('is skipped silently', rows.length === 0, rows.length)

    console.log('\n6. A booking, made as confirmed')
    const reservation = (over: Partial<Reservation>): Reservation =>
      ({
        id: `test-resv-${stamp}`,
        restaurantId: restaurant.id,
        branchId: null,
        tableId: null,
        customerName: 'Kamala Silva',
        customerPhone: '0712345678',
        partySize: 4,
        reservedAt: new Date(Date.now() + 3 * 3_600_000),
        status: 'CONFIRMED',
        ...over,
      }) as Reservation
    const booked = reservation({})
    await smsReservationSaved(booked, { wasNew: true, previousStatus: null })
    rows = await logFor(booked.id)
    check('one confirmation went out', rows.length === 1 && rows[0]!.status === 'SENT', rows.map((r) => r.status))
    check('naming the party size and a time', rows[0]?.body?.includes('for 4') === true && /\d:\d\d\s?(am|pm)/i.test(rows[0]?.body ?? ''), rows[0]?.body)
    await smsReservationSaved(booked, { wasNew: false, previousStatus: 'CONFIRMED' })
    rows = await logFor(booked.id)
    check('editing it sends nothing more', rows.length === 1, rows.length)

    console.log('\n7. A booking taken as pending, confirmed later')
    const pending = reservation({ id: `test-pending-${stamp}`, status: 'PENDING' })
    await smsReservationSaved(pending, { wasNew: true, previousStatus: null })
    await smsReservationSaved({ ...pending, status: 'CONFIRMED' }, { wasNew: false, previousStatus: 'PENDING' })
    rows = await logFor(pending.id)
    check('gets the booked text and then the confirmed text', rows.length === 2, rows.map((r) => r.dedupeKey))

    console.log('\n8. Reminders')
    const soon = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        customerName: 'Ruwan Jayasuriya',
        customerPhone: '0723456789',
        partySize: 2,
        reservedAt: new Date(Date.now() + 90 * 60_000),
        endsAt: new Date(Date.now() + 180 * 60_000),
        status: 'CONFIRMED',
        // Booked two hours ago: old enough that a reminder is not nagging.
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      },
    })
    createdReservations.push(soon.id)
    const justBooked = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        customerName: 'Just Booked',
        customerPhone: '0734567890',
        partySize: 2,
        reservedAt: new Date(Date.now() + 60 * 60_000),
        endsAt: new Date(Date.now() + 150 * 60_000),
        status: 'CONFIRMED',
      },
    })
    createdReservations.push(justBooked.id)
    const later = await prisma.reservation.create({
      data: {
        restaurantId: restaurant.id,
        customerName: 'Much Later',
        customerPhone: '0745678901',
        partySize: 2,
        reservedAt: new Date(Date.now() + 6 * 3_600_000),
        endsAt: new Date(Date.now() + 7.5 * 3_600_000),
        status: 'CONFIRMED',
        createdAt: new Date(Date.now() - 2 * 3_600_000),
      },
    })
    createdReservations.push(later.id)

    const summary = await sendReservationReminders()
    rows = await logFor(soon.id)
    check('the booking ninety minutes away is reminded', rows.length === 1 && rows[0]!.status === 'SENT', summary)
    check('with the reminder wording', rows[0]?.body?.startsWith('Reminder') === true, rows[0]?.body)
    check('the booking made minutes ago is left alone', (await logFor(justBooked.id)).length === 0)
    check('the booking six hours away is left alone', (await logFor(later.id)).length === 0)
    await sendReservationReminders()
    rows = await logFor(soon.id)
    check('the next sweep does not remind it again', rows.length === 1, rows.length)

    console.log('\n9. With SMS switched off entirely')
    await setConfig(configWith({ enabled: false }))
    const off = order({ id: `test-off-${stamp}` })
    await smsOrderPaid(off, { name: restaurant.name, currency: restaurant.currency })
    check('nothing is written for a paid bill', (await logFor(off.id)).length === 0)
  } finally {
    await prisma.restaurant.update({ where: { id: restaurant.id }, data: { smsConfig: originalConfig as never } })
    await prisma.smsMessage.deleteMany({
      where: {
        restaurantId: restaurant.id,
        OR: [{ entityId: { startsWith: `test-` } }, { entityId: { in: createdReservations } }],
      },
    })
    if (createdReservations.length) {
      await prisma.reservation.deleteMany({ where: { id: { in: createdReservations } } })
    }
    console.log('\nSettings restored, test rows removed.')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
