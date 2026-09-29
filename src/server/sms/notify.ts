import 'server-only'

import type { Order, Reservation, ReservationStatus } from '@prisma/client'

import { readSmsConfig } from '@/features/sms/config'
import { firstName, messageFor } from '@/features/sms/messages'
import type { SmsConfig, SmsTriggerKey } from '@/features/sms/types'
import { formatMoney } from '@/lib/money'
import { prisma } from '@/server/db/prisma'
import { sendSms } from './send'

/**
 * The texts that go out by themselves when something happens.
 *
 * ── The one rule ────────────────────────────────────────────────────────────
 *
 * Nothing here may break the thing that called it. A payment that has been
 * taken, an order the kitchen has marked ready, a booking a host has just
 * saved — each of those is done, and a text that could not be sent is a line
 * in the delivery log, never a failed payment. So every function catches
 * everything and `sendSms` itself never throws.
 *
 * ── Why each one asks first ─────────────────────────────────────────────────
 *
 * `sendSms` records a SUPPRESSED row for every refusal, which is right for a
 * message somebody meant to send. It is wrong for one nobody asked for: with
 * SMS switched off, every paid bill would add a row saying so. `armed` reads
 * the switches once and these return silently when the answer is no.
 */
async function armed(restaurantId: string, key: SmsTriggerKey): Promise<SmsConfig | null> {
  const config = await readSmsConfig(restaurantId)
  return config.enabled && config.triggers[key] ? config : null
}

function report(what: string, id: string, error: unknown) {
  console.error(`[sms] ${what} failed`, { id, error: error instanceof Error ? error.message : String(error) })
}

/** A date and a time as a guest reads them, in the restaurant's own clock. */
function when(at: Date, timeZone: string): { date: string; time: string } {
  const safeZone = (() => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone })
      return timeZone
    } catch {
      return 'Asia/Colombo'
    }
  })()
  return {
    date: new Intl.DateTimeFormat('en-GB', { timeZone: safeZone, day: 'numeric', month: 'short' }).format(at),
    time: new Intl.DateTimeFormat('en-GB', { timeZone: safeZone, hour: 'numeric', minute: '2-digit', hour12: true })
      .format(at)
      .replace(/\s?(am|pm)$/i, (m) => m.trim().toLowerCase()),
  }
}

/** The bill, once it is settled in full. */
export async function smsOrderPaid(
  order: Order,
  restaurant: { name: string; currency: string },
): Promise<void> {
  try {
    if (!order.customerPhone) return
    const config = await armed(order.restaurantId, 'receipt')
    if (!config) return

    await sendSms({
      restaurantId: order.restaurantId,
      branchId: order.branchId,
      to: order.customerPhone,
      text: messageFor(config.templates, 'receipt', {
        name: firstName(order.customerName),
        order: order.orderNumber,
        total: formatMoney(order.grandTotal, restaurant.currency),
        restaurant: restaurant.name,
      }),
      purpose: 'RECEIPT',
      trigger: 'receipt',
      // Once per bill, however many times settlement is re-derived.
      dedupeKey: `order-paid:${order.id}`,
      entity: 'Order',
      entityId: order.id,
      config,
    })
  } catch (error) {
    report('receipt', order.id, error)
  }
}

/**
 * The order is ready — or, for a delivery, on its way.
 *
 * A delivery order goes READY when it is handed to the delivery desk, which
 * is the moment the guest wants to hear about; "ready" would tell them to
 * come and collect something that is coming to them.
 */
export async function smsOrderReady(order: Order): Promise<void> {
  try {
    if (!order.customerPhone) return
    const key: SmsTriggerKey = order.type === 'DELIVERY' ? 'deliveryOnTheWay' : 'orderReady'
    const config = await armed(order.restaurantId, key)
    if (!config) return
    const restaurant = await prisma.restaurant.findUnique({
      where: { id: order.restaurantId },
      select: { name: true },
    })

    await sendSms({
      restaurantId: order.restaurantId,
      branchId: order.branchId,
      to: order.customerPhone,
      text: messageFor(config.templates, key, {
        name: firstName(order.customerName),
        order: order.orderNumber,
        restaurant: restaurant?.name ?? '',
      }),
      purpose: 'ORDER_STATUS',
      trigger: key,
      dedupeKey: `order-ready:${order.id}`,
      entity: 'Order',
      entityId: order.id,
      config,
    })
  } catch (error) {
    report('order ready', order.id, error)
  }
}

/** Statuses under which a booking still holds a table and a guest still expects to come. */
const UPCOMING: ReservationStatus[] = ['PENDING', 'CONFIRMED']

/**
 * A booking, when it is made — and again if it is confirmed later.
 *
 * Two different keys, because they are two different pieces of news: a
 * booking taken as PENDING says "we have your request", and its later move
 * to CONFIRMED says "it is definitely yours". A booking made as CONFIRMED
 * gets the first message only.
 */
export async function smsReservationSaved(
  reservation: Reservation,
  change: { wasNew: boolean; previousStatus: ReservationStatus | null },
): Promise<void> {
  try {
    if (!reservation.customerPhone) return
    const booked = change.wasNew && UPCOMING.includes(reservation.status)
    const confirmed =
      !change.wasNew && reservation.status === 'CONFIRMED' && change.previousStatus !== 'CONFIRMED'
    if (!booked && !confirmed) return

    const config = await armed(reservation.restaurantId, 'reservationConfirm')
    if (!config) return

    await sendSms({
      ...(await reservationMessage(reservation, config, 'reservationConfirm')),
      purpose: 'RESERVATION',
      trigger: 'reservationConfirm',
      dedupeKey: `${booked ? 'reservation-booked' : 'reservation-confirmed'}:${reservation.id}`,
    })
  } catch (error) {
    report('booking confirmation', reservation.id, error)
  }
}

/** The parts of a booking text that the confirmation and the reminder share. */
async function reservationMessage(
  reservation: Reservation,
  config: SmsConfig,
  key: 'reservationConfirm' | 'reservationReminder',
) {
  const [restaurant, table] = await Promise.all([
    prisma.restaurant.findUnique({
      where: { id: reservation.restaurantId },
      select: { name: true, timezone: true },
    }),
    reservation.tableId
      ? prisma.restaurantTable.findUnique({ where: { id: reservation.tableId }, select: { number: true } })
      : null,
  ])
  const at = when(reservation.reservedAt, restaurant?.timezone ?? 'Asia/Colombo')

  return {
    restaurantId: reservation.restaurantId,
    branchId: reservation.branchId,
    to: reservation.customerPhone,
    text: messageFor(config.templates, key, {
      name: firstName(reservation.customerName),
      party: reservation.partySize,
      date: at.date,
      time: at.time,
      table: table?.number ?? '',
      restaurant: restaurant?.name ?? '',
    }),
    entity: 'Reservation',
    entityId: reservation.id,
    config,
  }
}

/** How far ahead a reminder goes out. "A couple of hours before", as the switch says. */
const REMINDER_AHEAD_MS = 2 * 60 * 60 * 1000
/** A booking made this recently was just confirmed by text; a reminder on top is nagging. */
const REMINDER_MIN_AGE_MS = 60 * 60 * 1000

/**
 * Remind everybody whose booking is within the next two hours.
 *
 * Run by the job scheduler every fifteen minutes, so the window is wide and
 * the dedupe key is what stops a repeat: a booking is reminded once, on the
 * first run that finds it within reach, and never again. That also means a
 * scheduler that was down for an hour catches up on the next run rather
 * than skipping the bookings it missed.
 */
export async function sendReservationReminders(now: Date = new Date()): Promise<string> {
  const upcoming = await prisma.reservation.findMany({
    where: {
      status: { in: UPCOMING },
      reservedAt: { gt: now, lte: new Date(now.getTime() + REMINDER_AHEAD_MS) },
      createdAt: { lte: new Date(now.getTime() - REMINDER_MIN_AGE_MS) },
      customerPhone: { not: '' },
    },
    orderBy: { reservedAt: 'asc' },
    take: 500,
  })
  if (upcoming.length === 0) return 'no bookings due'

  // Already reminded on an earlier run — one query for the batch, not one each.
  const done = new Set(
    (
      await prisma.smsMessage.findMany({
        where: { dedupeKey: { in: upcoming.map((r) => `reservation-reminder:${r.id}`) } },
        select: { dedupeKey: true },
      })
    ).map((row) => row.dedupeKey),
  )

  const configs = new Map<string, SmsConfig | null>()
  let sent = 0
  let skipped = 0
  let failed = 0

  for (const reservation of upcoming) {
    const key = `reservation-reminder:${reservation.id}`
    if (done.has(key)) continue

    if (!configs.has(reservation.restaurantId)) {
      configs.set(reservation.restaurantId, await armed(reservation.restaurantId, 'reservationReminder'))
    }
    const config = configs.get(reservation.restaurantId)
    if (!config) {
      skipped += 1
      continue
    }

    try {
      const outcome = await sendSms({
        ...(await reservationMessage(reservation, config, 'reservationReminder')),
        purpose: 'RESERVATION',
        trigger: 'reservationReminder',
        dedupeKey: key,
      })
      if (outcome.sent) sent += 1
      else failed += 1
    } catch (error) {
      failed += 1
      report('booking reminder', reservation.id, error)
    }
  }

  return `${sent} reminded, ${failed} not sent, ${skipped} at restaurants with reminders off`
}
