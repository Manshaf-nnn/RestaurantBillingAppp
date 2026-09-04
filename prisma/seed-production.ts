/**
 * Production seed — creates ONLY the platform super-admin account.
 *
 * No demo restaurants, no sample orders, no fake data. Real restaurants are
 * created by real people signing up on your live site; you approve them from
 * the /admin console with this account.
 *
 *   SUPER_ADMIN_EMAIL=you@yourdomain.com \
 *   SUPER_ADMIN_PASSWORD='a-strong-password' \
 *   npm run db:seed:prod
 *
 * If SUPER_ADMIN_PASSWORD is omitted a strong one is generated and printed once.
 * Running it again never overwrites an existing admin's password unless you
 * explicitly pass SUPER_ADMIN_PASSWORD.
 */
import { PrismaClient } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { randomBytes } from 'node:crypto'

const prisma = new PrismaClient()

/**
 * Is this running inside a build, where stdout is a log somebody else can read?
 *
 * Netlify, Render and every other CI set this. It matters because the generated
 * password below used to be printed unconditionally: on a hosted build that
 * means a working super-admin credential sitting in the deploy log, readable by
 * anyone with access to the build history, for as long as the log is kept.
 */
function inCI(): boolean {
  return Boolean(
    process.env.CI ||
      process.env.NETLIFY ||
      process.env.RENDER ||
      process.env.GITHUB_ACTIONS ||
      process.env.BUILD_ID,
  )
}

async function main() {
  const emailFromEnv = process.env.SUPER_ADMIN_EMAIL?.toLowerCase().trim()

  /*
   * In CI the defaults are refused rather than assumed.
   *
   * This defaulted to `admin@example.com` and, with no password supplied,
   * generated one and printed it. Run on every production deploy — which it is,
   * from `netlify:build` — that meant a real SUPER_ADMIN account on a guessable
   * address, whose password had been written into a build log. Both halves are
   * fine locally and neither is acceptable on a deploy, so on a deploy the
   * build stops and says what to set.
   */
  if (inCI() && (!emailFromEnv || !process.env.SUPER_ADMIN_PASSWORD)) {
    console.error(
      '\n✖ Refusing to seed a platform admin during a build without explicit credentials.\n\n' +
        '  Set BOTH in the host\'s environment variables:\n' +
        '    SUPER_ADMIN_EMAIL     the address you will sign in with\n' +
        '    SUPER_ADMIN_PASSWORD  a strong password you already hold\n\n' +
        '  Without them this would create an account on a default address with a\n' +
        '  generated password printed into this build log, where anyone who can\n' +
        '  read the log can use it.\n',
    )
    process.exit(1)
  }

  const email = (emailFromEnv || 'admin@example.com').toLowerCase().trim()

  const providedPassword = process.env.SUPER_ADMIN_PASSWORD?.trim()
  const generated = !providedPassword
  const password = providedPassword || `${randomBytes(9).toString('base64url')}A9!`
  const passwordHash = await bcrypt.hash(password, 12)

  const existing = await prisma.user.findUnique({ where: { email } })

  if (existing) {
    await prisma.user.update({
      where: { email },
      data: {
        role: 'SUPER_ADMIN',
        restaurantId: null,
        isActive: true,
        deletedAt: null,
        // Only touch the password if the operator explicitly supplied one.
        ...(providedPassword ? { passwordHash } : {}),
      },
    })
    console.log(`\n✅ Super-admin already existed — role ensured for ${email}.`)
    if (providedPassword) console.log('   Password was reset to the value you provided.')
  } else {
    await prisma.user.create({
      data: {
        email,
        name: 'Platform Admin',
        role: 'SUPER_ADMIN',
        restaurantId: null,
        passwordHash,
        emailVerifiedAt: new Date(),
      },
    })
    console.log(`\n✅ Created platform super-admin.`)
    console.log(`   Email:    ${email}`)
    console.log(
      generated
        ? `   Password: ${password}\n   ⚠️  Save this now — it is shown only once.`
        : `   Password: (the value you supplied in SUPER_ADMIN_PASSWORD)`,
    )
  }

  console.log(`\n   Sign in at:  /login   →  you land on  /admin`)
  console.log(`   From /admin you approve or reject every new restaurant sign-up.\n`)
}

main()
  .catch((error) => {
    console.error('❌ Production seed failed:', error)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
