/**
 * The words a guest receives, and the blanks in them.
 *
 * One template per message, editable under Settings → SMS, with a standard
 * wording used whenever the owner leaves theirs blank. The placeholders are
 * the few things a guest would expect to see named: who they are, which
 * order, how much, when. Nothing here knows how the message is sent.
 *
 * Client-safe: the settings screen shows the standard wording and lists the
 * placeholders from these same tables.
 */

import type { SmsTriggerKey } from './types'

/** The messages that have a standard wording. OTP and offers are written by the owner. */
export type TemplatedTrigger = Exclude<SmsTriggerKey, 'otp' | 'marketing'>

export const DEFAULT_MESSAGES: Record<TemplatedTrigger, string> = {
  receipt: 'Thank you {name}! Your bill {order} at {restaurant} came to {total}. See you again soon.',
  orderReady: 'Hi {name}, your order {order} from {restaurant} is ready.',
  deliveryOnTheWay: 'Hi {name}, your order {order} from {restaurant} is on its way.',
  reservationConfirm:
    'Hi {name}, your table for {party} at {restaurant} is booked for {date} at {time}. See you then!',
  reservationReminder:
    'Reminder from {restaurant}: your table for {party} is at {time} on {date}. See you soon!',
}

/** Which blanks each message can use, for the hint under its text box. */
export const MESSAGE_PLACEHOLDERS: Record<SmsTriggerKey, string[]> = {
  receipt: ['name', 'order', 'total', 'restaurant'],
  orderReady: ['name', 'order', 'restaurant'],
  deliveryOnTheWay: ['name', 'order', 'restaurant'],
  reservationConfirm: ['name', 'party', 'date', 'time', 'table', 'restaurant'],
  reservationReminder: ['name', 'party', 'date', 'time', 'table', 'restaurant'],
  marketing: ['name', 'restaurant'],
  otp: ['code', 'restaurant'],
}

/** The first word of a name, which is how a text message addresses somebody. */
export function firstName(name: string | null | undefined): string {
  return (name ?? '').trim().split(/\s+/)[0] ?? ''
}

/**
 * Fill the blanks.
 *
 * A blank with nothing to put in it disappears rather than staying as
 * `{name}`, and the punctuation around it is tidied so a nameless walk-in
 * gets "Thank you! Your bill…" rather than "Thank you ! Your bill…".
 */
export function renderMessage(
  template: string,
  values: Record<string, string | number | null | undefined>,
): string {
  return template
    .replace(/\{([a-zA-Z]+)\}/g, (_whole, key: string) => {
      const value = values[key]
      return value === null || value === undefined ? '' : String(value)
    })
    .replace(/[ \t]+([,.!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
}

/** The owner's wording for this message, or the standard one, filled in. */
export function messageFor(
  templates: Partial<Record<SmsTriggerKey, string>>,
  key: TemplatedTrigger,
  values: Record<string, string | number | null | undefined>,
): string {
  const template = templates[key]?.trim() || DEFAULT_MESSAGES[key]
  return renderMessage(template, values)
}
