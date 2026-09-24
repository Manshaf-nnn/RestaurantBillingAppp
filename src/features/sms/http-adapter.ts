import 'server-only'

import { AppError } from '@/lib/errors'
import { assertSafeGatewayUrl, safeGatewayFetch, SsrfRefusedError } from '@/server/security/ssrf'

import { countSegments } from './encoding'
import { formatForGateway, type CountryDialling } from './msisdn'
import {
  TEMPLATE_TOKENS,
  type HttpGatewaySpec,
  type ResolvedSmsConfig,
  type SmsSendOutcome,
  type SmsSendRequest,
  type SuccessRule,
  type TemplateToken,
} from './types'

/**
 * Turning a template into a request, and a response into a verdict.
 *
 * Every gateway in the product goes through here — presets included — so that
 * the SSRF guard, the escaping and the success rules have exactly one
 * implementation to audit rather than one per vendor.
 */

type TokenValues = Partial<Record<TemplateToken, string>>

/* Where a substituted value is about to land, which decides how it is escaped. */
type Context = 'url' | 'form' | 'json' | 'header'

/**
 * Escape one value for where it is going.
 *
 * ── Why this is not one global escape ───────────────────────────────────────
 *
 * A message body is attacker-adjacent text: guests type their own names into
 * it, and an owner's template interpolates them. Percent-encoding a value
 * destined for a JSON body leaves the quotes intact, so a name containing `"`
 * closes the string and the rest of the message becomes additional JSON fields
 * — a guest could set `sender_id` by being called something unusual. Escaping
 * per destination is what makes a template safe to hand to a non-programmer.
 */
function escapeFor(value: string, context: Context): string {
  switch (context) {
    case 'url':
    case 'form':
      return encodeURIComponent(value)
    case 'json':
      /* Quote it as JSON, then drop the outer quotes — the template supplies those. */
      return JSON.stringify(value).slice(1, -1)
    case 'header':
      /* A newline in a header value splits the request. Nothing else to do. */
      return value.replace(/[\r\n]+/g, ' ')
  }
}

const TOKEN_PATTERN = /\{([a-zA-Z]+)\}/g

/** Substitute `{token}` occurrences, escaping each for its destination. */
function applyTemplate(template: string, values: TokenValues, context: Context): string {
  return template.replace(TOKEN_PATTERN, (whole, name: string) => {
    if (!(TEMPLATE_TOKENS as readonly string[]).includes(name)) return whole
    const value = values[name as TemplateToken]
    if (value === undefined) return ''
    return escapeFor(value, context)
  })
}

/**
 * Every token a spec references that we cannot fill.
 *
 * Checked when the config is saved, never at send time. A body template that
 * has quietly lost its `{message}` sends blank texts and is billed for every
 * one of them, so this refuses the save rather than discovering it in a log.
 */
export function unknownTokensIn(spec: HttpGatewaySpec): string[] {
  const sources = [spec.url, spec.bodyTemplate, ...Object.values(spec.headers)]
  if (spec.balance) sources.push(spec.balance.url)

  const unknown = new Set<string>()
  for (const source of sources) {
    for (const match of source.matchAll(TOKEN_PATTERN)) {
      if (!(TEMPLATE_TOKENS as readonly string[]).includes(match[1])) unknown.add(match[1])
    }
  }
  return [...unknown]
}

// ── Reading the answer ───────────────────────────────────────────────────────

/** `data.id` into a parsed body. Returns undefined rather than throwing. */
function readPath(source: unknown, path: string): unknown {
  let cursor = source
  for (const segment of path.split('.')) {
    if (cursor === null || typeof cursor !== 'object') return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

const asText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return null
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * Did the gateway accept it?
 *
 * The rule matters more than it looks. A gateway out of credit answers
 * `HTTP 200` with `{"status":"error"}`, and treating 2xx as success records
 * that as delivered — so the log reassures the owner while nothing arrives.
 */
function evaluateSuccess(rule: SuccessRule, status: number, body: string, parsed: unknown): boolean {
  const httpOk = status >= 200 && status < 300

  switch (rule.kind) {
    case 'httpStatus':
      return httpOk
    case 'jsonEquals': {
      const actual = asText(readPath(parsed, rule.path))
      if (actual === null) return false
      return rule.equals.some((candidate) => candidate.toLowerCase() === actual.toLowerCase())
    }
    case 'jsonTruthy': {
      const value = readPath(parsed, rule.path)
      return Boolean(value)
    }
    case 'bodyContains':
      return body.toLowerCase().includes(rule.needle.toLowerCase())
  }
}

/**
 * Whether trying again could plausibly work.
 *
 * A body-level rejection defaults to NOT retryable: the gateway received the
 * request, made a decision, and will make the same one in four minutes. The
 * cost of getting this wrong is five attempts over an hour ending in a
 * CRITICAL error, which buries the one line telling the owner their mask was
 * never approved.
 */
function classify(status: number, message: string): { code: string; retryable: boolean } {
  const text = message.toLowerCase()

  if (/credit|balance|insufficient|top ?up/.test(text)) {
    return { code: 'INSUFFICIENT_CREDIT', retryable: false }
  }
  if (/sender|mask|source ?addr/.test(text)) {
    return { code: 'INVALID_SENDER_ID', retryable: false }
  }
  if (/not verified|unverified|whitelist|allowed list/.test(text)) {
    return { code: 'NUMBER_NOT_VERIFIED', retryable: false }
  }
  if (/invalid (number|recipient|msisdn)|malformed/.test(text)) {
    return { code: 'INVALID_RECIPIENT', retryable: false }
  }
  if (status === 401 || status === 403 || /unauthor|invalid (api|key|token)|forbidden/.test(text)) {
    return { code: 'AUTH_FAILED', retryable: false }
  }
  if (status === 429 || /rate ?limit|too many/.test(text)) {
    return { code: 'RATE_LIMITED', retryable: true }
  }
  if (status >= 500) return { code: 'GATEWAY_ERROR', retryable: true }
  if (status >= 400) return { code: 'GATEWAY_REJECTED', retryable: false }

  return { code: 'GATEWAY_REJECTED', retryable: false }
}

// ── Building the request ─────────────────────────────────────────────────────

export interface PreparedRequest {
  method: string
  url: string
  headers: Record<string, string>
  body?: string
  /** What will actually be dialled, for the preview pane and the log. */
  dialled: string
}

/**
 * Build the request without sending it.
 *
 * Exported because the settings wizard renders exactly this, with credentials
 * masked, before the owner spends a credit. That preview is the cheapest place
 * to catch a wrong recipient format or an unapproved mask, and those two
 * account for most of the "it says success but nothing arrives" reports.
 */
export function prepareRequest(
  resolved: ResolvedSmsConfig,
  req: SmsSendRequest,
  country: CountryDialling,
  options: { maskCredentials?: boolean } = {},
): PreparedRequest {
  const { spec, credentials } = resolved
  const mask = (value: string | undefined) =>
    value === undefined ? undefined : options.maskCredentials ? '••••••••' : value

  const digits = req.to.replace(/\D/g, '')
  const dialled = formatForGateway(req.to, spec.numberFormat, country)
  const segments = countSegments(req.text, spec.encoding)

  const values: TokenValues = {
    to: dialled,
    toPlus: `+${digits}`,
    toNoPlus: digits,
    toLocal: formatForGateway(req.to, 'nationalLeadingZero', country),
    text: req.text,
    textEncoded: encodeURIComponent(req.text),
    sender: req.sender ?? '',
    reference: req.reference ?? '',
    unicode: spec.unicodeField
      ? segments.alphabet === 'UCS2'
        ? spec.unicodeField.unicodeValue
        : spec.unicodeField.gsm7Value
      : '',
    apiKey: mask(credentials.apiKey),
    apiSecret: mask(credentials.apiSecret),
    username: credentials.username,
    password: mask(credentials.password),
    accountId: credentials.accountId,
  }

  const headers: Record<string, string> = {}
  for (const [name, template] of Object.entries(spec.headers)) {
    headers[name] = applyTemplate(template, values, 'header')
  }

  switch (spec.auth.mode) {
    case 'bearer':
      headers.authorization = `Bearer ${mask(credentials.apiKey) ?? ''}`
      break
    case 'basic': {
      const user = credentials.username ?? credentials.accountId ?? ''
      const pass = options.maskCredentials ? '••••••••' : (credentials.password ?? credentials.apiSecret ?? '')
      headers.authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
      break
    }
    case 'header':
      headers[spec.auth.header] = mask(credentials.apiKey) ?? ''
      break
    case 'field':
    case 'none':
      break
  }

  let body: string | undefined
  if (spec.method === 'POST' && spec.bodyEncoding !== 'none') {
    body = applyTemplate(spec.bodyTemplate, values, spec.bodyEncoding === 'json' ? 'json' : 'form')
    if (spec.bodyEncoding === 'json' && !headers['content-type']) {
      headers['content-type'] = 'application/json'
    }
    if (spec.bodyEncoding === 'form' && !headers['content-type']) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
    }
  }

  /*
   * A GET gateway carries everything in the query string, so the body template
   * is appended to the URL rather than dropped — otherwise a spec written for
   * a GET gateway would send an empty request and report success.
   */
  let url = applyTemplate(spec.url, values, 'url')
  if (spec.method === 'GET' && spec.bodyTemplate.trim()) {
    const query = applyTemplate(spec.bodyTemplate, values, 'form')
    url += (url.includes('?') ? '&' : '?') + query
  }

  return { method: spec.method, url, headers, body, dialled }
}

/**
 * Send one message. Never throws.
 *
 * Every failure mode — a refused URL, DNS, a timeout, a 500, a 200 whose body
 * says no — comes back as an outcome, because the caller is a payment or an
 * order that must not roll back because a text did not go.
 */
export async function sendViaHttp(
  resolved: ResolvedSmsConfig,
  req: SmsSendRequest,
  country: CountryDialling,
  allowlist: string[] = [],
): Promise<SmsSendOutcome> {
  const { spec } = resolved
  let prepared: PreparedRequest

  try {
    prepared = prepareRequest(resolved, req, country)
  } catch (error) {
    return {
      ok: false,
      retryable: false,
      code: 'CONFIG_INVALID',
      message: error instanceof AppError ? error.message : 'The gateway configuration is invalid',
      raw: '',
    }
  }

  try {
    const safe = await assertSafeGatewayUrl(prepared.url, allowlist)
    const response = await safeGatewayFetch(safe, {
      method: prepared.method,
      headers: prepared.headers,
      body: prepared.body,
    })

    const parsed = parseBody(response.body)
    const accepted = evaluateSuccess(spec.success, response.status, response.body, parsed)

    if (accepted) {
      const id = spec.messageIdPath ? asText(readPath(parsed, spec.messageIdPath)) : null
      return { ok: true, providerMessageId: id, raw: response.body.slice(0, 2048) }
    }

    const message =
      (spec.errorMessagePath ? asText(readPath(parsed, spec.errorMessagePath)) : null) ??
      `The gateway did not accept the message (HTTP ${response.status})`
    const providerCode = spec.errorCodePath ? asText(readPath(parsed, spec.errorCodePath)) : null
    const { code, retryable } = classify(response.status, `${providerCode ?? ''} ${message}`)

    return {
      ok: false,
      retryable,
      code: providerCode ? `${code}:${providerCode}` : code,
      message,
      raw: response.body.slice(0, 2048),
    }
  } catch (error) {
    if (error instanceof SsrfRefusedError) {
      return { ok: false, retryable: false, code: 'URL_REFUSED', message: error.message, raw: '' }
    }

    /* The repo's convention: a timeout is told apart by its name, not its text. */
    if (error instanceof Error && error.name === 'TimeoutError') {
      return {
        ok: false,
        retryable: true,
        code: 'TIMEOUT',
        message: 'The gateway did not respond within 8 seconds',
        raw: '',
      }
    }

    return {
      ok: false,
      retryable: true,
      code: 'NETWORK_ERROR',
      message: error instanceof Error ? error.message : 'The gateway could not be reached',
      raw: '',
    }
  }
}

/** Credit probe. Same machinery, same guard, no message sent. */
export async function fetchBalance(
  resolved: ResolvedSmsConfig,
  country: CountryDialling,
  allowlist: string[] = [],
): Promise<{ amount: number | null; unit: string | null }> {
  const balance = resolved.spec.balance
  if (!balance) return { amount: null, unit: null }

  const prepared = prepareRequest(
    { ...resolved, spec: { ...resolved.spec, url: balance.url, method: balance.method } },
    { to: '+94000000000', text: '' },
    country,
  )

  const safe = await assertSafeGatewayUrl(prepared.url, allowlist)
  const response = await safeGatewayFetch(safe, {
    method: balance.method,
    headers: prepared.headers,
  })

  const parsed = parseBody(response.body)
  const rawAmount = asText(readPath(parsed, balance.amountPath))
  const amount = rawAmount === null ? null : Number(rawAmount)

  return {
    amount: amount === null || Number.isNaN(amount) ? null : amount,
    unit: balance.unitPath ? asText(readPath(parsed, balance.unitPath)) : null,
  }
}

export const __testing = { applyTemplate, escapeFor, readPath, evaluateSuccess, classify }
