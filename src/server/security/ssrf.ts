import 'server-only'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

import { AppError } from '@/lib/errors'
import { isProduction } from '@/lib/env'

/**
 * Guarding a URL that somebody else chose.
 *
 * ── What this is defending against ──────────────────────────────────────────
 *
 * The SMS feature lets a shop owner paste their gateway's endpoint, and our
 * server then fetches it with headers they control and shows them the answer.
 * That is a request-forgery primitive handed to every tenant. Pointed at
 * `http://169.254.169.254/latest/meta-data/iam/security-credentials/` it reads
 * the host's cloud credentials; pointed at an internal address it maps and
 * reaches the private network from outside it.
 *
 * The feature is still worth having — an owner's own gateway is the whole
 * point — so the URL is accepted and then constrained.
 *
 * ── Known residual risk: DNS rebinding ──────────────────────────────────────
 *
 * The checks below resolve the hostname, reject private answers, and then hand
 * the URL to `fetch`, which resolves it a SECOND time. A hostname under the
 * attacker's control can answer public on the first lookup and private on the
 * second, and the request goes where the check said it would not.
 *
 * Closing that hole means pinning the connection to the address we validated,
 * which needs an `undici.Agent` with a custom `connect.lookup`. `undici` is not
 * resolvable as a direct dependency here (Next bundles its own copy), so it
 * would have to be declared. That is a deliberate, un-taken decision rather
 * than an oversight, and this paragraph is the record of it.
 *
 * What holds the risk down meanwhile: setting a gateway URL requires
 * SETTINGS_MANAGE and is audited; `/admin/sms` lists every distinct gateway
 * host in use so an operator can look at the real surface; and the platform
 * setting `sms.hostAllowlist` can close it to named hosts without a deploy.
 */

const MAX_RESPONSE_BYTES = 8 * 1024
const TIMEOUT_MS = 8_000

/** Never accept these from a template — they let a body be reinterpreted. */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection'])

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    const octet = Number(part)
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return null
    value = value * 256 + octet
  }
  return value
}

const inRange = (value: number, cidrBase: string, bits: number): boolean => {
  const base = ipv4ToInt(cidrBase)
  if (base === null) return false
  const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0
  return (value & mask) >>> 0 === (base & mask) >>> 0
}

/**
 * Anything that is not a routable public IPv4 address.
 *
 * `169.254.0.0/16` is called out because `169.254.169.254` is the cloud
 * metadata endpoint on AWS, Azure, GCP and DigitalOcean alike, and reading it
 * is the single highest-value outcome of an SSRF on a hosted app.
 */
function isPrivateIPv4(ip: string): boolean {
  const value = ipv4ToInt(ip)
  if (value === null) return true // unparseable is not provably public

  return (
    inRange(value, '0.0.0.0', 8) || // "this network"
    inRange(value, '10.0.0.0', 8) || // RFC1918
    inRange(value, '100.64.0.0', 10) || // CGNAT
    inRange(value, '127.0.0.0', 8) || // loopback
    inRange(value, '169.254.0.0', 16) || // link-local, incl. cloud metadata
    inRange(value, '172.16.0.0', 12) || // RFC1918
    inRange(value, '192.0.0.0', 24) || // IETF protocol assignments
    inRange(value, '192.168.0.0', 16) || // RFC1918
    inRange(value, '198.18.0.0', 15) || // benchmarking
    inRange(value, '224.0.0.0', 4) || // multicast
    inRange(value, '240.0.0.0', 4) // reserved
  )
}

function isPrivateIPv6(ip: string): boolean {
  const normalised = ip.toLowerCase().split('%')[0] // strip any zone index

  if (normalised === '::1' || normalised === '::') return true

  /* IPv4-mapped and IPv4-compatible forms wrap a v4 address; judge that. */
  const mapped = normalised.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) return isPrivateIPv4(mapped[1])

  const head = parseInt(normalised.split(':')[0] || '0', 16)
  if (Number.isNaN(head)) return true

  if ((head & 0xfe00) === 0xfc00) return true // fc00::/7 unique-local
  if ((head & 0xffc0) === 0xfe80) return true // fe80::/10 link-local

  return false
}

const isPrivateAddress = (ip: string): boolean =>
  isIP(ip) === 6 ? isPrivateIPv6(ip) : isPrivateIPv4(ip)

/**
 * Loopback only — 127.0.0.0/8 and ::1, and the IPv4-mapped spelling of both.
 *
 * Narrower than `isPrivateAddress` on purpose: this is the one range the
 * development exception opens, so it must not quietly include the link-local
 * block that holds the cloud metadata address.
 */
function isLoopback(ip: string): boolean {
  const normalised = ip.toLowerCase().split('%')[0]
  if (normalised === '::1') return true

  const mapped = normalised.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/)
  const candidate = mapped ? mapped[1] : normalised

  const value = ipv4ToInt(candidate)
  return value !== null && inRange(value, '127.0.0.0', 8)
}

export class SsrfRefusedError extends AppError {
  constructor(message: string) {
    super(message, 400, 'GATEWAY_URL_REFUSED')
  }
}

export interface SafeUrl {
  url: URL
  /** Every address the hostname resolved to, all of them public. */
  addresses: string[]
}

/**
 * Accept a gateway URL, or refuse it with a reason the owner can act on.
 *
 * `allowlist` comes from the platform setting `sms.hostAllowlist`. Empty means
 * any public host, which is the default — an allowlist that must be edited
 * before a new tenant can onboard is an allowlist that gets emptied in a hurry.
 */
export async function assertSafeGatewayUrl(raw: string, allowlist: string[] = []): Promise<SafeUrl> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SsrfRefusedError('That is not a valid URL')
  }

  // 1 — scheme. http is for the local fake gateway in development only.
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !isProduction())) {
    throw new SsrfRefusedError(
      isProduction()
        ? 'The gateway URL must start with https://'
        : `Only http:// and https:// gateway URLs are allowed, not ${url.protocol}`,
    )
  }

  // 2 — credentials in the URL bypass header inspection and end up in logs.
  if (url.username || url.password) {
    throw new SsrfRefusedError(
      'Remove the username and password from the URL and enter them as credentials instead',
    )
  }

  // 3 — ports.
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80
  if (isProduction() && port !== 443) {
    throw new SsrfRefusedError('The gateway URL must use the standard HTTPS port')
  }

  // 4 — the host, if an operator has narrowed the surface.
  if (allowlist.length > 0 && !allowlist.includes(url.hostname.toLowerCase())) {
    throw new SsrfRefusedError(`${url.hostname} is not on this platform's allowed gateway list`)
  }

  // 5 — where the name actually points.
  let addresses: string[]
  if (isIP(url.hostname)) {
    addresses = [url.hostname]
  } else {
    try {
      const resolved = await lookup(url.hostname, { all: true })
      addresses = resolved.map((entry) => entry.address)
    } catch {
      throw new SsrfRefusedError(`${url.hostname} could not be resolved — check the URL`)
    }
  }

  if (addresses.length === 0) {
    throw new SsrfRefusedError(`${url.hostname} did not resolve to any address`)
  }

  /*
   * ANY private answer refuses the whole host, not just that address. A name
   * resolving to one public and one private address is how a rebinding attack
   * looks from here, not a coincidence worth accommodating.
   *
   * Outside production, loopback ALONE is permitted — and nothing else that is
   * private. `scripts/fake-sms-gateway.mjs` exists so the whole send path can
   * be exercised without an account or a credit, and it necessarily lives on
   * localhost; a guard that refuses it makes the one test that proves this
   * code impossible to run. Every other reserved range stays refused even in
   * development, so the metadata address and RFC1918 are still closed here and
   * the rule keeps being meaningfully exercised.
   */
  const loopbackOk = !isProduction()
  const offender = addresses.find(
    (address) => isPrivateAddress(address) && !(loopbackOk && isLoopback(address)),
  )
  if (offender) {
    throw new SsrfRefusedError(
      `${url.hostname} resolves to ${offender}, which is a private or reserved address`,
    )
  }

  return { url, addresses }
}

export interface SafeFetchResult {
  status: number
  /** Truncated at 8KB — a misconfigured URL must not become an OOM. */
  body: string
  contentType: string | null
}

/**
 * Fetch a validated gateway URL.
 *
 * `redirect: 'manual'` is not a preference. Following a redirect re-resolves a
 * hostname the guard never saw, which is the commonest way past a check like
 * `assertSafeGatewayUrl` — a 302 to the metadata address defeats every one of
 * the rules above. No real SMS send endpoint redirects, so treating a 3xx as a
 * gateway error costs nothing and closes the hole.
 */
export async function safeGatewayFetch(
  safe: SafeUrl,
  init: { method: string; headers: Record<string, string>; body?: string },
): Promise<SafeFetchResult> {
  for (const name of Object.keys(init.headers)) {
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      throw new SsrfRefusedError(`The header "${name}" cannot be set on a gateway request`)
    }
  }

  const response = await fetch(safe.url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
    cache: 'no-store',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })

  if (response.status >= 300 && response.status < 400) {
    throw new SsrfRefusedError(
      `The gateway redirected the request (HTTP ${response.status}), which is not allowed. Use the final URL directly.`,
    )
  }

  return {
    status: response.status,
    body: await readBounded(response),
    contentType: response.headers.get('content-type'),
  }
}

/** Read at most MAX_RESPONSE_BYTES, then stop pulling. */
async function readBounded(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''

  const chunks: Uint8Array[] = []
  let total = 0

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      chunks.push(value)
      total += value.byteLength
      if (total >= MAX_RESPONSE_BYTES) break
    }
  } finally {
    await reader.cancel().catch(() => {})
  }

  const joined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk.subarray(0, Math.min(chunk.byteLength, total - offset)), offset)
    offset += chunk.byteLength
    if (offset >= total) break
  }

  return new TextDecoder().decode(joined.subarray(0, MAX_RESPONSE_BYTES))
}

/** Exported for the test suite, which asserts each range individually. */
export const __testing = { isPrivateIPv4, isPrivateIPv6, isPrivateAddress }
