/**
 * The gateways we have filled the blanks in for.
 *
 * A preset is not an adapter. It is the same `HttpGatewaySpec` an owner could
 * type by hand, shipped pre-filled so that somebody on Notify.lk sees three
 * inputs instead of thirty. Nothing here can do something a custom gateway
 * cannot — which is what keeps the SSRF guard and the template escaping on one
 * path with no exceptions to audit.
 *
 * ── On the values below ─────────────────────────────────────────────────────
 *
 * These follow each vendor's published API. Before this ships, open a trial
 * account on each, send one real message, and pin the spec against the actual
 * request and response — particularly `success`, `messageIdPath` and
 * `numberFormat`, which are the three that fail quietly when wrong.
 *
 * Dialog eSMS and Mobitel mSMS are contract-negotiated: the endpoint and the
 * field names differ per account, so they ship with the URL blank and a note
 * telling the owner where to find theirs. A guessed URL would be worse than no
 * preset, because a wrong one looks configured.
 *
 * Client-safe: the wizard renders these cards, labels and help text.
 */

import type { HttpGatewaySpec, SmsCredentialField, SmsProviderKey } from './types'

export interface PresetCredentialField {
  name: SmsCredentialField
  /** This gateway's own word for it — "User ID", not "username". */
  label: string
  secret: boolean
  help: string
  example?: string
}

export interface SmsPreset {
  key: SmsProviderKey
  label: string
  /** One line under the card in the picker. */
  tagline: string
  credentialFields: PresetCredentialField[]
  /** Null for `custom`, and for gateways whose endpoint is per-contract. */
  spec: HttpGatewaySpec | null
  /** Shown in the wizard: where to find the key, how to get the mask approved. */
  onboardingNotes: string[]
  /** Whether the owner must supply the URL and body themselves. */
  requiresManualSpec: boolean
}

const APPROVAL_NOTE =
  'Your sender mask must be approved separately by each operator (Dialog, Mobitel, Hutch). ' +
  'Approval takes roughly 3–10 working days. An unapproved mask does not return an error — ' +
  'the gateway accepts the message and it is silently dropped or re-labelled.'

export const SMS_PRESETS: Record<SmsProviderKey, SmsPreset> = {
  notifylk: {
    key: 'notifylk',
    label: 'Notify.lk',
    tagline: 'Common Sri Lankan gateway. User ID plus API key.',
    credentialFields: [
      {
        name: 'username',
        label: 'User ID',
        secret: false,
        help: 'The numeric User ID shown on your Notify.lk dashboard.',
        example: '12345',
      },
      {
        name: 'apiKey',
        label: 'API key',
        secret: true,
        help: 'Dashboard → Settings → API. Paste it without surrounding spaces.',
      },
    ],
    spec: {
      method: 'POST',
      url: 'https://app.notify.lk/api/v1/send',
      headers: {},
      bodyEncoding: 'form',
      bodyTemplate: 'user_id={username}&api_key={apiKey}&sender_id={sender}&to={to}&message={text}',
      auth: { mode: 'field' },
      success: { kind: 'jsonEquals', path: 'status', equals: ['success'] },
      messageIdPath: 'data.id',
      errorMessagePath: 'message',
      /* Notify.lk wants 94771234567 — no plus, no leading zero. */
      numberFormat: 'e164NoPlus',
      encoding: 'auto',
      balance: {
        method: 'GET',
        url: 'https://app.notify.lk/api/v1/status?user_id={username}&api_key={apiKey}',
        amountPath: 'data.acc_balance',
      },
    },
    onboardingNotes: [
      'Find your User ID and API key under Settings → API on the Notify.lk dashboard.',
      APPROVAL_NOTE,
      'Trial accounts only deliver to numbers you have verified on the dashboard. Tick the trial box below and list them, or your guests will get nothing while your own phone works fine.',
    ],
    requiresManualSpec: false,
  },

  textlk: {
    key: 'textlk',
    label: 'Text.lk',
    tagline: 'Sri Lankan gateway. A single bearer token.',
    credentialFields: [
      {
        name: 'apiKey',
        label: 'API token',
        secret: true,
        help: 'Dashboard → Developers → API tokens. Sent as a Bearer token.',
      },
    ],
    spec: {
      method: 'POST',
      url: 'https://app.text.lk/api/v3/sms/send',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      bodyEncoding: 'json',
      bodyTemplate: '{"recipient":"{to}","sender_id":"{sender}","type":"plain","message":"{text}"}',
      auth: { mode: 'bearer' },
      success: { kind: 'jsonEquals', path: 'status', equals: ['success'] },
      messageIdPath: 'data.uid',
      errorMessagePath: 'message',
      numberFormat: 'e164NoPlus',
      encoding: 'auto',
    },
    onboardingNotes: [
      'Generate an API token under Developers → API tokens.',
      APPROVAL_NOTE,
      'Sinhala and Tamil messages are sent as unicode — 70 characters per segment instead of 160.',
    ],
    requiresManualSpec: false,
  },

  dialog: {
    key: 'dialog',
    label: 'Dialog eSMS',
    tagline: 'Enterprise account. Your account manager gives you the endpoint.',
    credentialFields: [
      { name: 'username', label: 'Username', secret: false, help: 'From your eSMS onboarding pack.' },
      { name: 'password', label: 'Password', secret: true, help: 'From your eSMS onboarding pack.' },
    ],
    spec: null,
    onboardingNotes: [
      'Dialog eSMS endpoints differ per contract, so there is nothing to pre-fill. Ask your account manager for the send URL and a sample request, then paste the sample into the box below — we will fill in the rest from it.',
      APPROVAL_NOTE,
      'eSMS accounts are usually IP-allowlisted. Send them the egress addresses shown further down this page.',
    ],
    requiresManualSpec: true,
  },

  mobitel: {
    key: 'mobitel',
    label: 'Mobitel mSMS',
    tagline: 'Enterprise account. Your account manager gives you the endpoint.',
    credentialFields: [
      { name: 'username', label: 'Username', secret: false, help: 'From your mSMS onboarding pack.' },
      { name: 'password', label: 'Password', secret: true, help: 'From your mSMS onboarding pack.' },
    ],
    spec: null,
    onboardingNotes: [
      'Mobitel mSMS endpoints differ per contract. Ask your account manager for the send URL and a sample request, then paste the sample below.',
      APPROVAL_NOTE,
      'mSMS accounts are usually IP-allowlisted. Send them the egress addresses shown further down this page.',
    ],
    requiresManualSpec: true,
  },

  custom: {
    key: 'custom',
    label: 'Another gateway',
    tagline: 'Any HTTP gateway. Paste a sample request from its documentation.',
    credentialFields: [
      { name: 'apiKey', label: 'API key / token', secret: true, help: 'Whatever your gateway calls its credential.' },
      { name: 'apiSecret', label: 'API secret', secret: true, help: 'Only if your gateway issued a pair.' },
      { name: 'username', label: 'Username / account ID', secret: false, help: 'Only if your gateway uses one.' },
      { name: 'password', label: 'Password', secret: true, help: 'Only if your gateway uses one.' },
    ],
    spec: null,
    onboardingNotes: [
      'Paste the sample request from your gateway\'s documentation and we will fill in the method, URL, headers and body for you.',
      'The two fields worth checking by hand are the recipient format and the success rule. A gateway that is out of credit usually answers HTTP 200 with an error in the body — without the success rule, every one of those is logged as delivered.',
      APPROVAL_NOTE,
    ],
    requiresManualSpec: true,
  },
}

export const PRESET_ORDER: SmsProviderKey[] = ['notifylk', 'textlk', 'dialog', 'mobitel', 'custom']

/**
 * The spec to send with: the preset's, or the owner's own.
 *
 * Presets keep their spec in code rather than copying it into every tenant's
 * row, so a corrected URL or success rule reaches every shop on the next deploy
 * instead of needing a migration over stored JSON.
 */
export function specFor(
  provider: SmsProviderKey,
  stored: HttpGatewaySpec | null,
): HttpGatewaySpec | null {
  const preset = SMS_PRESETS[provider]
  if (preset && !preset.requiresManualSpec && preset.spec) return preset.spec
  return stored
}

/** Which credential slots this gateway actually asks for. */
export function credentialFieldsFor(provider: SmsProviderKey): PresetCredentialField[] {
  return SMS_PRESETS[provider]?.credentialFields ?? []
}
