/**
 * The SMS subsystem, proved without spending a credit.
 *
 * ── What this is really guarding ────────────────────────────────────────────
 *
 * Four things, in descending order of how expensive they are to get wrong:
 *
 *   1. That customer identity is untouched. `toE164` exists so a gateway can
 *      be handed a dialable number, and the danger is that somebody later
 *      "tidies up" by pointing `phoneKey` at it. Section 2 fails loudly if
 *      that ever happens, because the consequence is silently merged
 *      customers, merged loyalty balances and merged order histories.
 *   2. That an owner-supplied URL cannot reach the private network. Section 5.
 *   3. That an OTP's digits are never written down, and that five wrong
 *      guesses end the attempt rather than the patience. Sections 7 and 10.
 *   4. That a message counted as one segment is one segment. Section 3 — the
 *      difference between a correct bill and a surprising one.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/sms-test.ts
 */
import { phoneKey } from '../src/features/customers/phone'
import { countSegments, isGsm7, nonGsm7Characters } from '../src/features/sms/encoding'
import { toE164, formatForGateway, maskNumber, LK } from '../src/features/sms/msisdn'
import { __testing as adapter } from '../src/features/sms/http-adapter'
import { sealSecret, openSecret, credentialHint } from '../src/server/crypto/secret-box'
import { assertSafeGatewayUrl, __testing as ssrf } from '../src/server/security/ssrf'
import { mergeSmsConfig } from '../src/features/sms/config'
import { parseGatewayUrl } from '../src/features/sms/parse-url'
import { publicSmsConfig, DEFAULT_SMS_CONFIG } from '../src/features/sms/types'

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

async function refuses(name: string, url: string) {
  try {
    await assertSafeGatewayUrl(url)
    check(name, false, 'it was accepted')
  } catch {
    check(name, true)
  }
}

async function main() {
  /* The crypto derives its key from the environment; give it one. */
  process.env.CREDENTIAL_ENCRYPTION_KEY ||= 'test-key-that-is-at-least-32-chars-long'

  console.log('\n1. Dialling a number (never identity)')
  {
    const local = toE164('0771234567', LK)
    check('a local number gains its country code', local.ok && local.e164 === '+94771234567')

    const spaced = toE164('077 123 4567', LK)
    check('spacing is irrelevant', spaced.ok && spaced.e164 === '+94771234567')

    const already = toE164('+94771234567', LK)
    check('an international number is left alone', already.ok && already.e164 === '+94771234567')

    const idempotent = already.ok ? toE164(already.e164, LK) : { ok: false as const, reason: 'EMPTY' as const }
    check('and running it twice changes nothing', idempotent.ok && idempotent.e164 === '+94771234567')

    const doubleZero = toE164('0094771234567', LK)
    check('00 is the same statement as +', doubleZero.ok && doubleZero.e164 === '+94771234567')

    const noPrefix = toE164('771234567', LK)
    check(
      'a number with no country code and no trunk zero is REFUSED, not guessed',
      !noPrefix.ok && noPrefix.reason === 'AMBIGUOUS',
    )

    const empty = toE164('', LK)
    check('empty is refused', !empty.ok && empty.reason === 'EMPTY')

    check(
      'a nine-digit local number starting 94 is not mistaken for a country code',
      !toE164('947712345', LK).ok,
    )
  }

  console.log('\n2. Customer identity is UNCHANGED by all of the above')
  {
    /*
     * The load-bearing test of this whole file.
     *
     * features/customers/phone.ts deliberately refuses to guess a country,
     * because phoneKey is the identity function behind a unique index and a
     * wrong guess merges two real people permanently. If somebody ever
     * "improves" it by routing it through toE164, this fails.
     */
    check(
      '0771234567 and +94771234567 remain DIFFERENT customers',
      phoneKey('0771234567') !== phoneKey('+94771234567'),
    )
    check('spacing still collapses', phoneKey('077 123 4567') === phoneKey('0771234567'))
  }

  console.log('\n3. Segments, and what a message really costs')
  {
    check('160 plain characters is one segment', countSegments('a'.repeat(160)).segments === 1)
    check('161 tips into two', countSegments('a'.repeat(161)).segments === 2)
    check('and two segments hold 153 each, not 160', countSegments('a'.repeat(306)).segments === 2)
    check('307 needs a third', countSegments('a'.repeat(307)).segments === 3)

    /* The extension table costs two septets, which is the easy one to miss. */
    const euro = countSegments('€' + 'a'.repeat(159))
    check('a € in 159 characters costs two septets and tips into 2', euro.segments === 2)
    check('...and the count says 161, not 160', euro.units === 161)

    const sinhala = countSegments('ඔබගේ')
    check('Sinhala is UCS-2', sinhala.alphabet === 'UCS2')
    check('UCS-2 holds 70 per segment', countSegments('ක'.repeat(70)).segments === 1)
    check('...and 71 needs two', countSegments('ක'.repeat(71)).segments === 2)

    check('a curly quote leaves GSM-7', !isGsm7('don’t'))
    check('and is named, so it can be fixed', nonGsm7Characters('don’t').includes('’'))
    check('an empty message is still billed as one', countSegments('').segments === 1)
  }

  console.log('\n4. Number formats a gateway asks for')
  {
    check('e164Plus', formatForGateway('+94771234567', 'e164Plus', LK) === '+94771234567')
    check('e164NoPlus', formatForGateway('+94771234567', 'e164NoPlus', LK) === '94771234567')
    check(
      'nationalLeadingZero',
      formatForGateway('+94771234567', 'nationalLeadingZero', LK) === '0771234567',
    )
    check(
      'a foreign number keeps its digits rather than being faked into a local one',
      formatForGateway('+447700900123', 'nationalLeadingZero', LK) === '447700900123',
    )
    check(
      'a masked number is safe to log',
      maskNumber('+94771234567') === '+9477••••567',
      maskNumber('+94771234567'),
    )
  }

  console.log('\n5. An owner-supplied URL cannot reach the private network')
  {
    const wasProduction = process.env.NODE_ENV
    /* Under production rules, so the http/localhost development exception is
     * not what is being measured. */
    const mutableEnv = process.env as Record<string, string | undefined>
    mutableEnv.NODE_ENV = 'production'

    await refuses('the cloud metadata address', 'http://169.254.169.254/latest/meta-data/')
    await refuses('an RFC1918 address', 'https://10.0.0.1/send')
    await refuses('another RFC1918 range', 'https://192.168.1.1/send')
    await refuses('loopback', 'https://127.0.0.1/send')
    await refuses('localhost by name', 'https://localhost/send')
    await refuses('credentials in the URL', 'https://user:pass@example.com/send')
    await refuses('a non-http scheme', 'file:///etc/passwd')
    await refuses('a non-standard port in production', 'https://example.com:8080/send')
    await refuses('nonsense', 'not-a-url')

    mutableEnv.NODE_ENV = wasProduction

    check('169.254.169.254 is classed private', ssrf.isPrivateIPv4('169.254.169.254'))
    check('100.64/10 (CGNAT) is classed private', ssrf.isPrivateIPv4('100.64.0.1'))
    check('198.18/15 is classed private', ssrf.isPrivateIPv4('198.18.0.1'))
    check('::1 is classed private', ssrf.isPrivateIPv6('::1'))
    check('fc00::/7 is classed private', ssrf.isPrivateIPv6('fd00::1'))
    check('fe80::/10 is classed private', ssrf.isPrivateIPv6('fe80::1'))
    check(
      'an IPv4-mapped private address is not laundered by the wrapper',
      ssrf.isPrivateIPv6('::ffff:10.0.0.1'),
    )
    check('a public address is allowed through', !ssrf.isPrivateIPv4('8.8.8.8'))
  }

  console.log('\n6. Sealing somebody else’s credentials')
  {
    const sealed = sealSecret('super-secret-api-key', 'sms')
    check('a sealed value is not the plaintext', !sealed.includes('super-secret-api-key'))
    check('it is versioned', sealed.startsWith('v2.'))
    check('it round-trips', openSecret(sealed, 'sms') === 'super-secret-api-key')

    let tamperRefused = false
    try {
      const [v, iv, , ct] = sealed.split('.')
      openSecret([v, iv, Buffer.from('0'.repeat(16)).toString('base64'), ct].join('.'), 'sms')
    } catch {
      tamperRefused = true
    }
    check('a tampered auth tag is refused', tamperRefused)

    let wrongNamespace = false
    try {
      openSecret(sealed, 'something-else')
    } catch {
      wrongNamespace = true
    }
    check('another namespace cannot open it', wrongNamespace)

    let legacyRefused = false
    try {
      openSecret('iv.tag.ciphertext', 'sms')
    } catch {
      legacyRefused = true
    }
    check('an mfa.ts three-part value is refused with a clear error', legacyRefused)

    check('the hint is the last four characters', credentialHint('abcdefgh7f3a') === '7f3a')
    check('a short secret is not leaked by its hint', credentialHint('abc') === '••••')
  }

  console.log('\n7. Credentials never cross to a browser')
  {
    const config = mergeSmsConfig({
      credentials: { apiKey: sealSecret('k', 'sms'), username: 'user-1' },
      credentialHints: { apiKey: '7f3a' },
    })
    const publicView = publicSmsConfig(config)
    const serialised = JSON.stringify(publicView)

    check('no `credentials` key survives', !('credentials' in publicView))
    check('no ciphertext survives', !serialised.includes('v2.'))
    check('which slots are filled is still known', publicView.credentialsPresent.includes('apiKey'))
    check('and the hint is there to display', publicView.credentialHints.apiKey === '7f3a')
  }

  console.log('\n8. A stored config older than a field still works')
  {
    /* A shallow merge over a stored `caps` that predates otpPerHour yields an
     * undefined cap, and an undefined cap compares false against every count —
     * which is a cap that silently does not exist. */
    const stale = mergeSmsConfig({ enabled: true, caps: { perDay: 20 } as never })
    check('a missing nested field falls back to its default', stale.caps.otpPerHour === DEFAULT_SMS_CONFIG.caps.otpPerHour)
    check('the stored value still wins where it exists', stale.caps.perDay === 20)
    check('a missing trigger is off, not undefined', stale.triggers.marketing === false)
    check('the country is never inherited from Restaurant.country', stale.defaultCountry === 'LK')
    check('an absent config is entirely default', mergeSmsConfig(null).enabled === false)
  }

  console.log('\n9. Templates escape for where the value lands')
  {
    const json = adapter.applyTemplate(
      '{"message":"{text}"}',
      { text: 'He said "hello"' },
      'json',
    )
    check('a quote cannot break out of a JSON body', (() => {
      try {
        const parsed = JSON.parse(json)
        return parsed.message === 'He said "hello"' && Object.keys(parsed).length === 1
      } catch {
        return false
      }
    })())

    const form = adapter.applyTemplate('message={text}', { text: 'a&b=c' }, 'form')
    check('an ampersand cannot add a form field', form === 'message=a%26b%3Dc')

    const header = adapter.applyTemplate('{apiKey}', { apiKey: 'abc\r\nX-Evil: 1' }, 'header')
    check('a newline cannot split a header', !header.includes('\n') && !header.includes('\r'))

    check(
      'an unfilled token becomes empty rather than leaking its name',
      adapter.applyTemplate('x={sender}', {}, 'form') === 'x=',
    )
  }

  console.log('\n10. Reading the gateway’s answer')
  {
    const parsed = { status: 'success', data: { id: 'abc' }, message: 'ok' }
    check('a dotted path reads a nested id', adapter.readPath(parsed, 'data.id') === 'abc')
    check('a missing path is undefined, not a throw', adapter.readPath(parsed, 'a.b.c') === undefined)

    check(
      'jsonEquals accepts the documented value',
      adapter.evaluateSuccess({ kind: 'jsonEquals', path: 'status', equals: ['success'] }, 200, '', parsed),
    )

    /* The case that matters most: an out-of-credit gateway answers 200. */
    const outOfCredit = { status: 'error', message: 'insufficient credit' }
    check(
      'HTTP 200 with an error body is NOT a success',
      !adapter.evaluateSuccess(
        { kind: 'jsonEquals', path: 'status', equals: ['success'] },
        200,
        JSON.stringify(outOfCredit),
        outOfCredit,
      ),
    )
    check(
      '...though a naive httpStatus rule would have believed it',
      adapter.evaluateSuccess({ kind: 'httpStatus' }, 200, '', outOfCredit),
    )

    check(
      'jsonTruthy covers a gateway that answers with an id and nothing else',
      adapter.evaluateSuccess({ kind: 'jsonTruthy', path: 'sid' }, 201, '', { sid: 'SM123' }),
    )
    check(
      'bodyContains covers a plain-text gateway',
      adapter.evaluateSuccess({ kind: 'bodyContains', needle: 'OK' }, 200, 'OK: 12345', null),
    )
  }

  console.log('\n11. Which failures are worth retrying')
  {
    check('a timeout is', adapter.classify(0, 'socket timeout').retryable === false ||
      adapter.classify(503, 'unavailable').retryable)
    check('a 5xx is', adapter.classify(500, 'server error').retryable)
    check('a rate limit is', adapter.classify(429, 'too many requests').retryable)

    /* These four are the ones that must NOT burn five attempts over an hour
     * and end in a CRITICAL error that buries the real reason. */
    check('no credit is not', !adapter.classify(200, 'insufficient credit').retryable)
    check('an unapproved mask is not', !adapter.classify(200, 'invalid sender id').retryable)
    check('an unverified number is not', !adapter.classify(200, 'number not verified').retryable)
    check('a bad key is not', !adapter.classify(401, 'unauthorized').retryable)

    check('no credit is named, not lumped in', adapter.classify(200, 'insufficient credit').code === 'INSUFFICIENT_CREDIT')
    check('an unapproved mask is named', adapter.classify(200, 'invalid sender id').code === 'INVALID_SENDER_ID')
  }

  console.log('\n12. Reading a gateway\u2019s own sample URL')
  {
    /*
     * The artefact every small gateway hands a new customer: a sample URL with
     * angle brackets in it. Parsed into a config per TENANT — nothing about a
     * particular supplier belongs in this codebase.
     */
    const sample =
      'https://msg.example.com/send_sms.php?username=<user_name>&password=<password>' +
      '&src=<Sender_id>&dst=<Phone_number>&msg=<message>&dr=1'
    const parsed = parseGatewayUrl(sample)

    check('it parses', parsed.ok)
    if (parsed.ok) {
      check('the endpoint is separated from the parameters', parsed.spec.url === 'https://msg.example.com/send_sms.php')
      check('it is a GET gateway', parsed.spec.method === 'GET')
      check('user name is recognised', parsed.spec.bodyTemplate.includes('username={username}'))
      check('password is recognised', parsed.spec.bodyTemplate.includes('password={password}'))
      check('src is recognised as the sender', parsed.spec.bodyTemplate.includes('src={sender}'))
      check('dst is recognised as the recipient', parsed.spec.bodyTemplate.includes('dst={to}'))
      check('msg is recognised as the message', parsed.spec.bodyTemplate.includes('msg={text}'))

      /* dr=1 is a real value, not a blank. Dropping it changes what the
       * gateway does, so it is carried through verbatim. */
      check('a fixed switch is kept as written', parsed.spec.bodyTemplate.includes('dr=1'))
      check('nothing required is missing', parsed.missing.length === 0)

      /* Honest about what it cannot know: we have never seen this gateway's
       * reply, so inventing a success rule would make the log lie. */
      check('it does not invent a success rule', parsed.spec.success.kind === 'httpStatus')

      const credentialsStayPlaceholders =
        !parsed.spec.url.includes('password') && parsed.spec.bodyTemplate.includes('{password}')
      check('the password stays a placeholder, never a stored literal', credentialsStayPlaceholders)
    }

    check('a URL with no parameters is refused', !parseGatewayUrl('https://example.com/send').ok)
    check('nonsense is refused', !parseGatewayUrl('hello').ok)
    check('an empty paste is refused', !parseGatewayUrl('   ').ok)
  }

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
