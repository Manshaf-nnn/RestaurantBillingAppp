/**
 * The shape of a tenant's own SMS gateway.
 *
 * ── Why a generic HTTP spec and not one adapter per vendor ──────────────────
 *
 * Most shop owners already pay for a gateway before they ever ask us for SMS —
 * Notify.lk, Text.lk, or a Dialog/Mobitel account negotiated per contract. The
 * feature is therefore not "integrate a provider", it is "accept whichever
 * gateway this owner already has, including ones nobody here has seen". A
 * vendor-per-adapter design answers that with a code change and a deploy every
 * time a new shop signs up, which is the wrong unit of work.
 *
 * So the adapter is a template: a URL, a method, a header map, a body, and a
 * rule for reading the answer. A preset is nothing more than that template with
 * the blanks filled in. Twilio needs zero bespoke code under this shape, which
 * is the evidence it is general enough to hold the gateways we have not met.
 *
 * ── Client-safe, deliberately ───────────────────────────────────────────────
 *
 * No `server-only` here and no Prisma import: the settings wizard renders the
 * preset cards, the credential labels and the live request preview in the
 * browser. Anything that touches the database lives in `./config`, and anything
 * that makes a request lives in `./http-adapter`.
 */

export type SmsProviderKey = 'notifylk' | 'textlk' | 'dialog' | 'mobitel' | 'custom'

/** The credential slots any gateway may draw on. Not every gateway uses all. */
export type SmsCredentialField = 'apiKey' | 'apiSecret' | 'username' | 'password' | 'accountId'

// ── Sending ──────────────────────────────────────────────────────────────────

export interface SmsSendRequest {
  /**
   * Already resolved to E.164 by `toE164`. An adapter never guesses a country:
   * by the time a request reaches one, the ambiguity has been resolved or the
   * send has been refused.
   */
  to: string
  text: string
  /** The owner's approved mask. A gateway that ignores it says so in `raw`. */
  sender?: string
  /** Our `SmsMessage.id`, for gateways that echo a client reference back. */
  reference?: string
}

export type SmsSendOutcome =
  | { ok: true; providerMessageId: string | null; raw: string }
  | {
      ok: false
      /**
       * What the retry queue reads.
       *
       * A timeout or a 5xx is worth trying again. `INVALID_SENDER_ID`,
       * `INSUFFICIENT_CREDIT`, `NUMBER_NOT_VERIFIED` and a 4xx auth failure are
       * not — re-queuing those burns five attempts over an hour and ends in a
       * CRITICAL `captureError`, which buries the one line that would have told
       * the owner their mask was never approved.
       */
      retryable: boolean
      code: string
      message: string
      raw: string
    }

export interface SmsProvider {
  readonly key: SmsProviderKey
  /**
   * Never throws. DNS failure, timeout, a 500, or a 200 whose body says "no"
   * are all outcomes, because the caller is a payment or an order that must not
   * roll back because a text did not go.
   */
  send(req: SmsSendRequest): Promise<SmsSendOutcome>
  /** Credit probe. Running out of credit is the commonest silent outage. */
  balance?(): Promise<{ amount: number | null; unit: string | null }>
}

// ── The generic HTTP gateway ─────────────────────────────────────────────────

export type HttpGatewayAuth =
  /** IP-allowlisted accounts. The allowlist is then the only protection. */
  | { mode: 'none' }
  /** The key travels as `{apiKey}` inside the URL or body — most SL gateways. */
  | { mode: 'field' }
  /** `Authorization: Bearer {apiKey}` */
  | { mode: 'bearer' }
  /** `Authorization: Basic base64({username}:{password})` */
  | { mode: 'basic' }
  /** A named header, e.g. `api-key: {apiKey}`. */
  | { mode: 'header'; header: string }

/**
 * How to tell, from the response, whether the gateway accepted the message.
 *
 * This is not ceremony. A gateway out of credit answers `HTTP 200` with
 * `{"status":"error","message":"insufficient balance"}`, and a delivery log
 * that treats 2xx as success records that message as sent — so the owner is
 * told everything is fine while nothing arrives. Getting this field right is
 * the difference between a log worth reading and one that lies.
 */
export type SuccessRule =
  /** 2xx is enough. Correct for very few gateways; offered because some exist. */
  | { kind: 'httpStatus' }
  /** A dotted JSON path equals one of these, case-insensitively. ~90% of cases. */
  | { kind: 'jsonEquals'; path: string; equals: string[] }
  /** A dotted JSON path exists and is truthy — e.g. Twilio's `sid`. */
  | { kind: 'jsonTruthy'; path: string }
  /** Plain-text gateways that answer `OK: 12345`. */
  | { kind: 'bodyContains'; needle: string }

/**
 * What shape of number this gateway wants.
 *
 * The single commonest cause of "it reports success and nothing arrives".
 * Notify.lk wants `94771234567`, Twilio wants `+94771234567`, and some local
 * gateways want `0771234567` — and a gateway handed the wrong one usually
 * accepts it, bills for it, and drops it.
 */
export type NumberFormat = 'e164Plus' | 'e164NoPlus' | 'nationalLeadingZero'

export type EncodingMode = 'auto' | 'gsm7' | 'unicode'

export interface HttpGatewaySpec {
  method: 'GET' | 'POST'
  /** A template. May contain any placeholder token. */
  url: string
  /** Header NAMES are literal; header VALUES are templates. */
  headers: Record<string, string>
  bodyEncoding: 'none' | 'json' | 'form'
  /** Template: JSON text for `json`, `a={x}&b={y}` for `form`, unused for `none`. */
  bodyTemplate: string
  auth: HttpGatewayAuth
  success: SuccessRule
  /** Dotted paths into the parsed JSON response. */
  messageIdPath?: string
  errorMessagePath?: string
  errorCodePath?: string
  numberFormat: NumberFormat
  encoding: EncodingMode
  /** Some gateways need an explicit field when the text is not GSM-7. */
  unicodeField?: { name: string; gsm7Value: string; unicodeValue: string }
  /** Optional credit probe, driven by the same template machinery. */
  balance?: { method: 'GET' | 'POST'; url: string; amountPath: string; unitPath?: string }
}

/**
 * Every placeholder an owner may write into a template.
 *
 * Unknown tokens are a validation error when the config is saved, never a
 * silent empty string: a body that quietly loses its `{message}` sends blank
 * texts and bills for every one of them.
 */
export const TEMPLATE_TOKENS = [
  'to',
  'toPlus',
  'toNoPlus',
  'toLocal',
  'text',
  'textEncoded',
  'sender',
  'reference',
  'unicode',
  'apiKey',
  'apiSecret',
  'username',
  'password',
  'accountId',
] as const

export type TemplateToken = (typeof TEMPLATE_TOKENS)[number]

// ── Stored configuration ─────────────────────────────────────────────────────

export type SmsTriggerKey =
  | 'otp'
  | 'receipt'
  | 'orderReady'
  | 'reservationConfirm'
  | 'reservationReminder'
  | 'marketing'

export interface SmsConfig {
  enabled: boolean
  provider: SmsProviderKey
  senderId: string
  /**
   * The owner confirming their mask is approved with each operator.
   *
   * In Sri Lanka a sender mask needs per-operator approval — Dialog, Mobitel
   * and Hutch separately — and takes days. An unapproved mask does not error:
   * the gateway returns success and the message is dropped or rewritten. So
   * this is a checkbox the owner ticks, and triggers stay locked until they do.
   */
  senderIdApproved: boolean
  /**
   * Stamped only by a successful test send, cleared whenever credentials change.
   * No trigger fires while this is null — a tenant who half-filled the form is
   * not a tenant who agreed to text their guests.
   */
  verifiedAt: string | null
  /**
   * Which country an unprefixed local number belongs to.
   *
   * Fixed to LK in v1. It is a field rather than a constant because `toE164`
   * must be handed one explicitly — and because `Restaurant.country` defaults
   * to "IN", which must never be inherited here by accident.
   */
  defaultCountry: 'LK'
  /** Only when `provider === 'custom'`; presets carry their spec in code. */
  spec: HttpGatewaySpec | null
  /** AES-256-GCM ciphertext. Never plaintext, never sent to a browser. */
  credentials: Partial<Record<SmsCredentialField, string>>
  /** Last 4 plaintext characters, for the `•••• 7f3a` display. Not a secret. */
  credentialHints: Partial<Record<SmsCredentialField, string>>
  caps: { perDay: number; perRecipientPerDay: number; otpPerHour: number }
  /** Per-message cost in minor units, typed by the owner from their tariff. */
  costMinor: number | null
  costCurrency: string | null
  /** All false on save. Configuring a gateway is not consenting to use it. */
  triggers: Record<SmsTriggerKey, boolean>
  templates: Partial<Record<SmsTriggerKey, string>>
  /**
   * Trial accounts silently drop anything not on their verified list, which
   * presents as "it works for the owner and for nobody else" and costs a week.
   */
  trialOnlyVerified: boolean
  /** Digits-only, compared with `phoneKey()`. */
  verifiedRecipients: string[]
  /** Numbers that asked to stop. Digits-only, compared with `phoneKey()`. */
  optOut: string[]
}

export const DEFAULT_SMS_CONFIG: SmsConfig = {
  enabled: false,
  provider: 'notifylk',
  senderId: '',
  senderIdApproved: false,
  verifiedAt: null,
  defaultCountry: 'LK',
  spec: null,
  credentials: {},
  credentialHints: {},
  caps: {
    /* Roomy for a busy venue's receipts and codes; far below a runaway loop. */
    perDay: 500,
    /* One guest does not need eleven texts in a day. This is what catches a
     * trigger that fires on every status write instead of every transition. */
    perRecipientPerDay: 10,
    otpPerHour: 100,
  },
  costMinor: null,
  costCurrency: null,
  triggers: {
    otp: false,
    receipt: false,
    orderReady: false,
    reservationConfirm: false,
    reservationReminder: false,
    marketing: false,
  },
  templates: {},
  trialOnlyVerified: false,
  verifiedRecipients: [],
  optOut: [],
}

/** A config with its credentials decrypted, as an adapter needs them. */
export interface ResolvedSmsConfig {
  config: SmsConfig
  spec: HttpGatewaySpec
  credentials: Partial<Record<SmsCredentialField, string>>
}

// ── What may cross to a browser ──────────────────────────────────────────────

export type PublicSmsConfig = Omit<SmsConfig, 'credentials'> & {
  /** Which credential slots hold a value — never the values themselves. */
  credentialsPresent: SmsCredentialField[]
}

/**
 * Strip the ciphertext before this reaches a client component.
 *
 * Ciphertext is not plaintext, but it is still the credential: anything that
 * reaches a browser reaches its extensions, its cache and its devtools, and an
 * owner's laptop is not where another company's API key belongs. The page
 * shows `•••• 7f3a` from `credentialHints` instead.
 *
 * Lives here rather than in `./config` so that a client component can name the
 * type without importing a `server-only` module.
 */
export function publicSmsConfig(config: SmsConfig): PublicSmsConfig {
  const { credentials, ...rest } = config
  return {
    ...rest,
    credentialsPresent: Object.entries(credentials)
      .filter(([, value]) => Boolean(value))
      .map(([name]) => name as SmsCredentialField),
  }
}
