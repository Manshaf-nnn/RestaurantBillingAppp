/**
 * The security defects the 2026-09-13 audit found that a service call can
 * prove (bugfix.md S5, S12, S15, D19). The ones that need a session — the
 * staff-codes page, the pulse stream, cross-tenant writes through real
 * Server Actions — live in security-runtime-test.ts.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/bugfix-security-test.ts
 */
import { SignJWT } from 'jose'

import { prisma } from '../src/server/db/prisma'
import { audit } from '../src/server/audit'
import { signAccessToken, verifyAccessToken } from '../src/server/auth/jwt'
import { readOutbox } from '../src/server/realtime/outbox'
import { ensureDefaultBranch } from '../src/features/branches/service'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const stamp = Date.now().toString(36)
  const restaurant = await prisma.restaurant.create({
    data: { name: `Sec ${stamp}`, slug: `sec-${stamp}`, status: 'ACTIVE', isActive: true, currency: 'LKR' },
  })
  const main = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Main', code: 'SM', isDefault: true } })
  const kandy = await prisma.branch.create({ data: { restaurantId: restaurant.id, name: 'Kandy', code: 'SK' } })

  console.log('\n── S12. Credentials never reach the audit trail ──')
  {
    await audit({
      restaurantId: restaurant.id, action: `sec.redact.${stamp}`, entity: 'User', entityId: 'x',
      before: {
        signInCode: 'ABC123', mfaSecret: 'mfa', totpSecret: 'totp', recoveryCodes: ['r1', 'r2'],
        keyHash: 'kh', qrPayload: 'qr', accountNumber: '0123456789', name: 'keep me',
        nested: { accountNumber: '9', label: 'visible' },
      },
      after: { list: [{ signInCode: 'Z' }] },
    })
    const row = await prisma.auditLog.findFirst({ where: { restaurantId: restaurant.id, action: `sec.redact.${stamp}` } })
    const before = (row?.before ?? {}) as Record<string, unknown>
    const secrets = ['signInCode', 'mfaSecret', 'totpSecret', 'recoveryCodes', 'keyHash', 'qrPayload', 'accountNumber']
    check('every credential column this schema holds is written as [redacted]',
      secrets.every((key) => before[key] === '[redacted]'), JSON.stringify(secrets.map((k) => [k, before[k]])))
    check('…including inside nested objects and arrays',
      (before.nested as Record<string, unknown>)?.accountNumber === '[redacted]' &&
        ((row?.after as { list: Array<Record<string, unknown>> })?.list?.[0]?.signInCode === '[redacted]'))
    check('while ordinary fields stay legible', before.name === 'keep me' && (before.nested as Record<string, unknown>)?.label === 'visible')
  }

  console.log('\n── S15. Only the algorithm we sign with is accepted ──')
  {
    const claims = { sub: 'u', rid: restaurant.id, role: 'OWNER', name: 'n', email: 'e@x', sid: 's' }
    const good = await signAccessToken(claims as Parameters<typeof signAccessToken>[0])
    check('a token we minted verifies', (await verifyAccessToken(good))?.sub === 'u')

    const key = new TextEncoder().encode(process.env.JWT_ACCESS_SECRET ?? '')
    const hs384 = await new SignJWT(claims).setProtectedHeader({ alg: 'HS384', typ: 'JWT' })
      .setSubject('u').setIssuedAt().setIssuer('restaurantos').setAudience('restaurantos.app').setExpirationTime('5m').sign(key)
    check('the same claims under HS384 with the same secret are refused', (await verifyAccessToken(hs384)) === null)

    const [header, payload] = good.split('.')
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${payload}.`
    check('an unsigned "none" token is refused', (await verifyAccessToken(none)) === null)
    void header
  }

  console.log('\n── S5. The event stream is confined the way every branch guard is ──')
  {
    await prisma.outboxEvent.createMany({
      data: [
        { restaurantId: restaurant.id, branchId: main.id, type: 'ORDER_CREATED', entity: 'Order', entityId: 'm' },
        { restaurantId: restaurant.id, branchId: kandy.id, type: 'ORDER_CREATED', entity: 'Order', entityId: 'k' },
        { restaurantId: restaurant.id, branchId: null, type: 'MENU_CHANGED', entity: 'Menu', entityId: null },
      ],
    })
    const all = await readOutbox({ restaurantId: restaurant.id, branchIds: null, since: 0n })
    const kandyOnly = await readOutbox({ restaurantId: restaurant.id, branchIds: [kandy.id], since: 0n })
    const nowhere = await readOutbox({ restaurantId: restaurant.id, branchIds: [], since: 0n })
    const omitted = await readOutbox({ restaurantId: restaurant.id, since: 0n })
    check('an unrestricted reader hears every branch', all.events.length === 3, `${all.events.length}`)
    check('a Kandy reader hears Kandy plus the restaurant-wide events, never Main',
      kandyOnly.events.length === 2 && kandyOnly.events.every((e) => e.branchId !== main.id), JSON.stringify(kandyOnly.events.map((e) => e.entityId)))
    check('a confined reader with nowhere to look hears nothing', nowhere.events.length === 0 && nowhere.seq === null)
    check('the legacy call with no reach at all still means unrestricted — the route now never makes it', omitted.events.length === 3)
  }

  console.log('\n── D19. The default location is the one marked default ──')
  {
    // Main was created first and marked default; an older-first fallback that
    // ignored the flag would still pick it here — so flip the flag to Kandy.
    await prisma.branch.update({ where: { id: main.id }, data: { isDefault: false } })
    await prisma.branch.update({ where: { id: kandy.id }, data: { isDefault: true } })
    const picked = await ensureDefaultBranch(restaurant.id)
    check('the resolver returns the branch flagged default, not the oldest', picked.id === kandy.id, picked.name)
    await prisma.branch.update({ where: { id: kandy.id }, data: { isDefault: false } })
    await prisma.branch.update({ where: { id: main.id }, data: { isDefault: true } })

    let second = ''
    try {
      await prisma.branch.update({ where: { id: kandy.id }, data: { isDefault: true } })
    } catch (error) { second = error instanceof Error ? error.message : String(error) }
    check('the database refuses a second default at the same restaurant', /unique|Unique/.test(second), second.slice(0, 80) || 'it was allowed')
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  console.log(`\n${passed} passed, ${failed} failed`)
  await prisma.$disconnect()
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (error) => { console.error(error); await prisma.$disconnect(); process.exit(1) })
