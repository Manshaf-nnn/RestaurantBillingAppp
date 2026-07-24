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

async function main() {
  const email = (process.env.SUPER_ADMIN_EMAIL || 'admin@example.com').toLowerCase().trim()

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
