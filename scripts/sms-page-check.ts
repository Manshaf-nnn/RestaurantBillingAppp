/**
 * Does the SMS tab actually render for an owner?
 *
 * Renders /dashboard/settings over HTTP as a signed-in owner and looks for the
 * things only this feature puts on the page. Cheaper than a browser and it
 * catches the failure that type-checking cannot: a server-only module pulled
 * into a client component, which throws at render rather than at compile.
 *
 *   PORT=3211 npm run dev
 *   BASE_URL=http://localhost:3211 npx tsx --tsconfig tsconfig.test.json scripts/sms-page-check.ts
 */
import { prisma } from '../src/server/db/prisma'
import { generateToken, hashToken } from '../src/server/auth/password'
import { ACCESS_COOKIE, REFRESH_COOKIE, signAccessToken } from '../src/server/auth/jwt'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3211'

async function main() {
  const owner = await prisma.user.findFirstOrThrow({
    where: { role: 'OWNER', restaurantId: { not: null } },
    select: { id: true, restaurantId: true, role: true, name: true, email: true },
  })

  const refresh = generateToken()
  const session = await prisma.session.create({
    data: {
      userId: owner.id,
      refreshTokenHash: hashToken(refresh),
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  })
  const access = await signAccessToken({
    sub: owner.id,
    rid: owner.restaurantId,
    role: owner.role,
    name: owner.name,
    email: owner.email,
    sid: session.id,
  } as Parameters<typeof signAccessToken>[0])

  const cookie = `${ACCESS_COOKIE}=${access}; ${REFRESH_COOKIE}=${refresh}`

  try {
    const response = await fetch(`${BASE_URL}/dashboard/settings?tab=sms`, {
      headers: { cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(180_000),
    })
    const html = await response.text()

    console.log(`\nSigned in as ${owner.email}`)
    console.log(`GET /dashboard/settings?tab=sms -> HTTP ${response.status}\n`)

    const wants: Array<[string, string]> = [
      ['the SMS tab exists', 'SMS'],
      ['the gateway picker is rendered', 'Notify.lk'],
      ['Text.lk is offered too', 'Text.lk'],
      ['it says where things stand', 'SMS is not set up yet'],
      ['the sender-approval question is asked', 'My sender name is approved'],
      ['the trial-account question is asked', 'This is a free trial account'],
      ['the test button is there', 'Send test message'],
      ['the message list is there', 'Send the bill by SMS'],
      ['advanced is folded away', 'Advanced'],
    ]

    let failed = 0
    for (const [name, needle] of wants) {
      const ok = html.includes(needle)
      if (!ok) failed += 1
      console.log(`  ${ok ? '✓' : '✗'} ${name}`)
    }

    /* The whole point of the boundary: no credential may appear in the HTML. */
    const leaks = ['v2.', 'CREDENTIAL_ENCRYPTION_KEY=', 'apiKey":"']
    for (const leak of leaks) {
      const clean = !html.includes(leak)
      if (!clean) failed += 1
      console.log(`  ${clean ? '✓' : '✗'} no "${leak}" in the HTML`)
    }

    console.log(failed === 0 ? '\nThe SMS tab renders.\n' : `\n${failed} checks failed.\n`)
    process.exitCode = failed === 0 ? 0 : 1
  } finally {
    await prisma.session.delete({ where: { id: session.id } }).catch(() => {})
    await prisma.$disconnect()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
