/**
 * Turning the one line a gateway's documentation gives you into a config.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * Every small gateway hands a new customer the same artefact: a sample URL
 * with angle brackets in it.
 *
 *   https://msg.example.com/send_sms.php?username=<user_name>&password=<password>
 *     &src=<Sender_id>&dst=<Phone_number>&msg=<message>&dr=1
 *
 * A restaurant owner can paste that. They cannot fill in a form asking for a
 * body template, an auth mode and a dotted JSON path, and they should never be
 * asked to. So the paste is the input, and everything else is derived from it.
 *
 * ── Why it is not a preset ──────────────────────────────────────────────────
 *
 * Because it belongs to one shop. Hardcoding a gateway into the product means
 * every other tenant sees a card for somebody else's supplier, and the next
 * customer's gateway needs a deploy. The result of this parse is stored on
 * that tenant's own `smsConfig.spec` — their data, not our code.
 *
 * Client-safe: the form shows what it understood as the owner types.
 */

import type { HttpGatewaySpec, NumberFormat, TemplateToken } from './types'

/**
 * What a gateway calls a thing, and what we call it.
 *
 * Matched against both the placeholder (`<user_name>`) and the parameter name
 * (`username=`), because documentation is inconsistent about which carries the
 * meaning — some write `user=<username>`, others `username=<your login>`.
 */
const SYNONYMS: Array<{ token: TemplateToken; words: string[] }> = [
  { token: 'username', words: ['username', 'user_name', 'user', 'uid', 'user_id', 'userid', 'login'] },
  { token: 'password', words: ['password', 'pass', 'pwd', 'passwd'] },
  { token: 'sender', words: ['sender_id', 'senderid', 'sender', 'src', 'from', 'mask', 'source', 'originator'] },
  { token: 'to', words: ['phone_number', 'phonenumber', 'dst', 'to', 'msisdn', 'recipient', 'mobile', 'number', 'destination'] },
  { token: 'text', words: ['message', 'msg', 'text', 'body', 'sms', 'content'] },
  { token: 'apiKey', words: ['api_key', 'apikey', 'key', 'token', 'api_token', 'auth_token'] },
  { token: 'apiSecret', words: ['api_secret', 'apisecret', 'secret'] },
  { token: 'accountId', words: ['account_id', 'accountid', 'account', 'client_id', 'clientid', 'sid'] },
]

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

function tokenFor(paramName: string, placeholder: string): TemplateToken | null {
  const candidates = [normalise(placeholder), normalise(paramName)]
  for (const { token, words } of SYNONYMS) {
    for (const word of words) {
      if (candidates.includes(normalise(word))) return token
    }
  }
  /* Fall back to a contains match — "your_sender_id" should still find sender. */
  for (const { token, words } of SYNONYMS) {
    for (const word of words) {
      if (candidates.some((candidate) => candidate.includes(normalise(word)))) return token
    }
  }
  return null
}

/** Whether a value looks like a blank to be filled, rather than a real value. */
const isPlaceholder = (value: string): boolean =>
  /^[<{[(]/.test(value.trim()) || /^(your|the)[_\s-]/i.test(value.trim()) || value.trim() === ''

export interface ParsedParam {
  name: string
  /** What the documentation wrote there. */
  given: string
  /** What we will substitute, or null when we kept the literal value. */
  token: TemplateToken | null
  /** A fixed value the gateway wants passed through, e.g. `dr=1`. */
  literal: string | null
}

export interface ParsedGateway {
  ok: true
  spec: HttpGatewaySpec
  params: ParsedParam[]
  /** Tokens we could not find a home for — the owner must check these. */
  missing: TemplateToken[]
}

export interface ParseFailure {
  ok: false
  reason: string
}

/** The tokens a gateway must receive for a message to mean anything. */
const REQUIRED: TemplateToken[] = ['to', 'text']

/**
 * Read a sample URL into a spec.
 *
 * A parameter whose value looks like a blank (`<message>`, `{msg}`, empty)
 * becomes a placeholder. One with a real value (`dr=1`, `type=text`) is kept
 * verbatim — those are the gateway's own switches and dropping them changes
 * what it does.
 */
export function parseGatewayUrl(raw: string, numberFormat: NumberFormat = 'e164NoPlus'): ParsedGateway | ParseFailure {
  const trimmed = raw.trim().replace(/\s+/g, '')
  if (!trimmed) return { ok: false, reason: 'Paste the sample URL your gateway gave you' }

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'That does not look like a web address — it should start with https://' }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'The address must start with https://' }
  }

  const params: ParsedParam[] = []
  const found = new Set<TemplateToken>()

  url.searchParams.forEach((given, name) => {
    if (isPlaceholder(given)) {
      const token = tokenFor(name, given)
      if (token) found.add(token)
      params.push({ name, given, token, literal: token ? null : given })
    } else {
      /* A real value: the gateway's own switch, kept as written. */
      params.push({ name, given, token: null, literal: given })
    }
  })

  if (params.length === 0) {
    return { ok: false, reason: 'That address has no parameters on it — paste the full sample including the ? part' }
  }

  const query = params
    .map((param) => {
      if (param.token) return `${param.name}={${param.token}}`
      return `${param.name}=${param.literal ?? ''}`
    })
    .join('&')

  const spec: HttpGatewaySpec = {
    method: 'GET',
    url: `${url.origin}${url.pathname}`,
    headers: {},
    bodyEncoding: 'form',
    bodyTemplate: query,
    /* Credentials ride in the query string, which is what `field` means. */
    auth: { mode: 'field' },
    /*
     * Deliberately the weakest rule, and the form says so.
     *
     * We have not seen this gateway's reply, and inventing a success rule is
     * how a delivery log ends up reporting failures as sent. `httpStatus` is
     * honest about knowing nothing; the test send prints the real reply and
     * the owner then sets the rule from what they actually saw.
     */
    success: { kind: 'httpStatus' },
    numberFormat,
    encoding: 'auto',
  }

  return {
    ok: true,
    spec,
    params,
    missing: REQUIRED.filter((token) => !found.has(token)),
  }
}

/** Plain-English name for a token, for the "what we understood" table. */
export const TOKEN_LABELS: Record<string, string> = {
  username: 'your user name',
  password: 'your password',
  apiKey: 'your API key',
  apiSecret: 'your API secret',
  accountId: 'your account ID',
  sender: 'your sender name',
  to: 'the guest’s phone number',
  toPlus: 'the phone number with +',
  toNoPlus: 'the phone number without +',
  toLocal: 'the phone number starting 0',
  text: 'the message',
  textEncoded: 'the message',
  reference: 'our reference',
  unicode: 'the unicode flag',
}
