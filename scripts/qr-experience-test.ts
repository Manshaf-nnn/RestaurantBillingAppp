/**
 * QR menus: the configuration layer over the existing systems (ar.md).
 *
 * §28's scenarios, in order, plus the two regressions that make the whole
 * thing safe to build on:
 *
 *   - an existing customer keeps their NAME through the entry gate AND through
 *     `placeOrder`, whose upsert rewrites it on every order;
 *   - a QR-scoped offer is refused in all three wrong directions, the
 *     `qrExperienceId: null` one included — otherwise "Student QR only" is
 *     typeable at the till.
 *
 * What this deliberately does NOT re-test: menu pricing, discount arithmetic,
 * loyalty maths, table rules and order placement all belong to the systems
 * this layer configures, and each already has its own suite. What is tested
 * here is that the configuration reaches them and that nothing was duplicated.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/qr-experience-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { evaluate } from '../src/features/customers/discounts'
import { findOrCreateCustomer } from '../src/features/customers/service'
import { balanceForPhone } from '../src/features/loyalty/service'
import { placeOrder } from '../src/features/orders/service'
import { PUBLIC_ID_PATTERN, newPublicId } from '../src/features/qr/public-id'
import { qrPath } from '../src/features/qr/guest-path'
import { hexToRgb, narrowAppearance, readAppearance } from '../src/features/guest/appearance'
import {
  categoriesFor,
  experienceMenu,
  experienceStats,
  fieldsFor,
  listExperiences,
  getExperience,
  resolveExperience,
} from '../src/features/qr/queries'
import {
  capProfile,
  createExperience,
  enterExperience,
  recordOpen,
  regeneratePublicId,
  saveExperience,
  setExperienceActive,
} from '../src/features/qr/service'

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`)
  }
}

async function refuses(name: string, run: () => Promise<unknown>, expect: RegExp) {
  try {
    await run()
    check(name, false, 'it was allowed')
  } catch (error) {
    const code = (error as { code?: string }).code ?? ''
    const message = error instanceof Error ? error.message : String(error)
    check(name, expect.test(`${code} ${message}`), `wrong reason: ${code} ${message}`)
  }
}

const stamp = Date.now().toString(36)
let restaurantId: string | null = null
let otherId: string | null = null

async function cleanup(id: string) {
  await prisma.couponRedemption.deleteMany({ where: { coupon: { restaurantId: id } } })
  await prisma.coupon.deleteMany({ where: { restaurantId: id } })
  await prisma.orderEvent.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.orderItem.deleteMany({ where: { order: { restaurantId: id } } })
  await prisma.order.deleteMany({ where: { restaurantId: id } })
  await prisma.tableSession.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurantTable.deleteMany({ where: { restaurantId: id } })
  await prisma.customer.deleteMany({ where: { restaurantId: id } })
  await prisma.qrExperienceField.deleteMany({ where: { experience: { restaurantId: id } } })
  await prisma.qrExperience.deleteMany({ where: { restaurantId: id } })
  await prisma.customerCategory.deleteMany({ where: { restaurantId: id } })
  await prisma.foodBranch.deleteMany({ where: { restaurantId: id } })
  await prisma.food.deleteMany({ where: { restaurantId: id } })
  await prisma.category.deleteMany({ where: { restaurantId: id } })
  await prisma.branch.deleteMany({ where: { restaurantId: id } })
  await prisma.restaurant.deleteMany({ where: { id } })
}

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: {
      name: `QR Co ${stamp}`, slug: `qr-${stamp}`, email: `qr-${stamp}@test.local`,
      status: 'ACTIVE', isActive: true, timezone: 'Asia/Colombo', currency: 'LKR',
    },
  })
  restaurantId = restaurant.id

  const main = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Main', code: 'MAIN', isDefault: true },
  })
  const beach = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Beach', code: 'BCH' },
  })
  const tableAtMain = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: main.id, number: '1', capacity: 4 },
  })
  const tableAtBeach = await prisma.restaurantTable.create({
    data: { restaurantId: restaurant.id, branchId: beach.id, number: '9', capacity: 2 },
  })

  const lunch = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Lunch', slug: `lunch-${stamp}` },
  })
  const drinks = await prisma.category.create({
    data: { restaurantId: restaurant.id, name: 'Drinks', slug: `drinks-${stamp}` },
  })
  const food = async (name: string, categoryId: string) => {
    const row = await prisma.food.create({
      data: {
        restaurantId: restaurant.id, categoryId, name,
        slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${stamp}`, price: 50_000, isAvailable: true,
      },
    })
    await prisma.foodBranch.createMany({
      data: [
        { restaurantId: restaurant.id, foodId: row.id, branchId: main.id, isAvailable: true },
        { restaurantId: restaurant.id, foodId: row.id, branchId: beach.id, isAvailable: true },
      ],
    })
    return row
  }
  const rice = await food('Rice', lunch.id)
  const tea = await food('Tea', drinks.id)

  const student = await prisma.customerCategory.create({
    data: { restaurantId: restaurant.id, name: 'Student', sortOrder: 0 },
  })
  const vip = await prisma.customerCategory.create({
    data: { restaurantId: restaurant.id, name: 'VIP', sortOrder: 1 },
  })

  console.log('\n── 1. The public code ──')
  {
    const codes = new Set(Array.from({ length: 200 }, () => newPublicId()))
    check('codes are 10 characters of the reduced alphabet', [...codes].every((c) => PUBLIC_ID_PATTERN.test(c)))
    check('no I, L, O or U — a code gets read aloud', [...codes].every((c) => !/[ilou]/.test(c)))
    check('200 draws, 200 distinct codes', codes.size === 200)
    check('the path is short and carries nothing else', qrPath('abcdefghjk') === '/m/abcdefghjk')
    check('and nests', qrPath('abcdefghjk', 'menu') === '/m/abcdefghjk/menu')
  }

  console.log('\n── 2. DEFAULT QR: a name and a branch is a working code (§21, §28) ──')
  let defaultId = ''
  let defaultCode = ''
  {
    const created = await createExperience({
      restaurantId: restaurant.id, branchId: main.id, name: 'Table cards',
    })
    defaultId = created.id
    defaultCode = created.publicId
    check('it takes orders by default', created.type === 'ORDERING')
    check('nobody is asked anything', created.identifyCustomer === false && created.askCustomerCategory === false)
    check('the whole menu is shown', created.menuMode === 'ALL')
    check('it is live', created.isActive)
    check('the public code is not the row id', created.publicId !== created.id && PUBLIC_ID_PATTERN.test(created.publicId))

    const resolved = await resolveExperience(created.publicId)
    check('it resolves by its printed code, with its restaurant and branch', resolved?.id === created.id && resolved.branch.code === 'MAIN')
    check('an unknown code resolves to nothing', (await resolveExperience('zzzzzzzzzz')) === null)
    check('and so does something that is not a code at all', (await resolveExperience('../../etc')) === null)

    const menu = await experienceMenu(resolved!, restaurant.timezone)
    check('the default menu is the branch menu, unfiltered', menu.items.length === 2 && menu.categories.length === 2)

    await refuses('a nameless code is refused',
      () => createExperience({ restaurantId: restaurant.id, branchId: main.id, name: '  ' }), /QR_NO_NAME/)
  }

  console.log('\n── 3. MENU ONLY: nothing is ordered and no table is taken (§3B, §16, §28) ──')
  let menuOnlyCode = ''
  {
    const sessionsBefore = await prisma.tableSession.count({ where: { restaurantId: restaurant.id } })
    const ordersBefore = await prisma.order.count({ where: { restaurantId: restaurant.id } })

    const created = await createExperience({
      restaurantId: restaurant.id, branchId: main.id, name: 'Window poster', type: 'MENU_ONLY',
    })
    menuOnlyCode = created.publicId
    const resolved = await resolveExperience(created.publicId)
    const menu = await experienceMenu(resolved!, restaurant.timezone)
    check('the menu still reads', menu.items.length === 2)
    check('no table session was opened', (await prisma.tableSession.count({ where: { restaurantId: restaurant.id } })) === sessionsBefore)
    check('and no order exists', (await prisma.order.count({ where: { restaurantId: restaurant.id } })) === ordersBefore)
    check('the type is what decides ordering — there is no second switch', created.type === 'MENU_ONLY')

    const page = readFileSync('src/app/m/[code]/cart/page.tsx', 'utf8')
    check('the cart route refuses a menu-only code outright', page.includes("if (experience.type !== 'ORDERING') notFound()"))
    const browser = readFileSync('src/features/orders/components/menu-browser.tsx', 'utf8')
    check('and the menu hides every path into the basket', browser.includes('ordering && itemCount > 0') && browser.includes('readOnly={!ordering}'))
    const sheet = readFileSync('src/features/orders/components/item-sheet.tsx', 'utf8')
    check('including the Add button itself', sheet.includes('{readOnly ? null : ('))
  }

  console.log('\n── 4. STUDENT QR: the right questions, and only those (§5, §6, §7, §28) ──')
  let studentId = ''
  let studentCode = ''
  {
    const created = await createExperience({
      restaurantId: restaurant.id, branchId: main.id, name: 'Student menu',
    })
    studentId = created.id
    studentCode = created.publicId

    await saveExperience({
      restaurantId: restaurant.id,
      experienceId: studentId,
      input: {
        name: 'Student menu', description: 'Show your campus ID', branchId: main.id,
        type: 'ORDERING', askTable: true, menuMode: 'CUSTOM', menuCategoryIds: [lunch.id], menuFoodIds: [],
        identifyCustomer: true, askCustomerCategory: true, customerCategoryIds: [student.id, vip.id],
        showSearch: true, showPrices: true, showOffers: true, showLoyalty: true,
        fields: [
          { key: 'name', label: 'Name', type: 'TEXT', rule: 'OPTIONAL', categoryId: null, sortOrder: 0 },
          { key: 'phone', label: 'Phone number', type: 'PHONE', rule: 'REQUIRED', categoryId: null, sortOrder: 1 },
          { key: 'campus-id', label: 'Campus ID', type: 'TEXT', rule: 'REQUIRED', categoryId: student.id, sortOrder: 2 },
          { key: 'company', label: 'Company name', type: 'TEXT', rule: 'REQUIRED', categoryId: vip.id, sortOrder: 3 },
        ],
      },
    })

    const saved = (await getExperience({ restaurantId: restaurant.id, experienceId: studentId }))!
    check('four questions are stored', saved.fields.length === 4)
    check('the built-ins are marked as such', saved.fields.filter((f) => f.isBuiltIn).length === 2)
    check('and the owner\'s own are not', saved.fields.find((f) => f.key === 'campus-id')?.isBuiltIn === false)

    const forStudent = fieldsFor(saved.fields, student.id)
    check('a student is asked name, phone and campus ID', forStudent.map((f) => f.key).sort().join(',') === 'campus-id,name,phone')
    const forVip = fieldsFor(saved.fields, vip.id)
    check('a VIP is asked for a company, NOT a campus ID', forVip.map((f) => f.key).sort().join(',') === 'company,name,phone')
    const forNobody = fieldsFor(saved.fields, null)
    check('somebody who picks nothing is asked only the general ones', forNobody.map((f) => f.key).sort().join(',') === 'name,phone')

    const offered = await categoriesFor(saved)
    check('both chosen categories are offered', offered.length === 2)

    const menu = await experienceMenu(saved, restaurant.timezone)
    check('the menu is narrowed to the chosen section', menu.items.length === 1 && menu.items[0].id === rice.id)
    check('and the empty section is dropped', menu.categories.length === 1 && menu.categories[0].id === lunch.id)

    // §5 — the configuration that cannot work is refused where the owner can see it.
    await refuses('identifying customers with no phone box is refused', () =>
      saveExperience({
        restaurantId: restaurant.id, experienceId: studentId,
        input: {
          name: 'Student menu', description: null, branchId: main.id, type: 'ORDERING', askTable: true,
          menuMode: 'ALL', menuCategoryIds: [], menuFoodIds: [],
          identifyCustomer: true, askCustomerCategory: false, customerCategoryIds: [],
          showSearch: true, showPrices: true, showOffers: true, showLoyalty: true,
          fields: [{ key: 'name', label: 'Name', type: 'TEXT', rule: 'REQUIRED', categoryId: null, sortOrder: 0 }],
        },
      }), /QR_PHONE_REQUIRED/)

    await refuses('so is a category that does not exist', () =>
      saveExperience({
        restaurantId: restaurant.id, experienceId: studentId,
        input: {
          name: 'Student menu', description: null, branchId: main.id, type: 'ORDERING', askTable: true,
          menuMode: 'ALL', menuCategoryIds: [], menuFoodIds: [],
          identifyCustomer: false, askCustomerCategory: true, customerCategoryIds: ['cjld2cjxh0000qzrmn831i7rn'],
          showSearch: true, showPrices: true, showOffers: true, showLoyalty: true, fields: [],
        },
      }), /QR_CATEGORY_MISSING/)
  }

  console.log('\n── 5. NEW CUSTOMER: created once, in the existing CRM (§8, §28) ──')
  let studentCustomerId = ''
  {
    const experience = (await getExperience({ restaurantId: restaurant.id, experienceId: studentId }))!

    await refuses('a required campus ID is enforced', () =>
      enterExperience({
        experience, fields: experience.fields, categoryId: student.id,
        answers: { name: 'Nimal', phone: '0771234567' },
      }), /QR_FIELD_REQUIRED/)

    const entered = await enterExperience({
      experience, fields: experience.fields, categoryId: student.id,
      answers: { name: 'Nimal', phone: '077 123 4567', 'campus-id': 'ABC123' },
    })
    studentCustomerId = entered.customerId!
    check('a customer was created', entered.created && entered.customerId !== null)

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: entered.customerId! } })
    check('filed under the chosen category', row.categoryId === student.id)
    check('with the phone key set, so one person stays one record', row.phoneKey === '0771234567')
    check('the campus ID is on the customer', (row.profile as Record<string, { value: string; label: string }>)['campus-id']?.value === 'ABC123')
    check('labelled in the owner\'s own words', (row.profile as Record<string, { value: string; label: string }>)['campus-id']?.label === 'Campus ID')
    check('and the built-ins went to real columns, not the json', !('name' in (row.profile as object)) && !('phone' in (row.profile as object)))
    check('where they came from is recorded', row.sourceQrExperienceId === studentId)

    // The same person, the number typed differently.
    const again = await enterExperience({
      experience, fields: experience.fields, categoryId: student.id,
      answers: { name: 'Nimal', phone: '0771234567', 'campus-id': 'ABC123' },
    })
    check('the same number in another shape finds the same record', again.customerId === entered.customerId && !again.created)
    check('no second customer', (await prisma.customer.count({ where: { restaurantId: restaurant.id } })) === 1)
  }

  console.log('\n── 6. EXISTING CUSTOMER: their name survives the gate AND the order (§8, §28) ──')
  {
    const experience = (await getExperience({ restaurantId: restaurant.id, experienceId: studentId }))!
    const existing = await findOrCreateCustomer({
      restaurantId: restaurant.id,
      input: { phone: '0779999999', name: 'Jonathan Perera' },
    })
    const before = await prisma.customer.count({ where: { restaurantId: restaurant.id } })

    const entered = await enterExperience({
      experience, fields: experience.fields, categoryId: student.id,
      answers: { name: 'Jon', phone: '0779999999', 'campus-id': 'XYZ789' },
    })
    check('the same record, not a new one', entered.customerId === existing!.customer.id && !entered.created)
    check('no customer was added', (await prisma.customer.count({ where: { restaurantId: restaurant.id } })) === before)

    const row = await prisma.customer.findUniqueOrThrow({ where: { id: entered.customerId! } })
    check('their name was NOT overwritten by the gate', row.name === 'Jonathan Perera')
    check('but the news about them was kept', row.categoryId === student.id)
    check('and they are not credited to this code — they were already a customer', row.sourceQrExperienceId === null)
    check('the gate returns the CANONICAL name and phone', entered.customerName === 'Jonathan Perera' && entered.customerPhone === '0779999999')

    /*
     * The regression this whole design turns on: `placeOrder` upserts by the
     * exact phone string and rewrites the name unconditionally. Sending back
     * what the gate returned makes that a no-op; sending back what was TYPED
     * would rename a regular to "Jon" for ever.
     */
    const order = await placeOrder({
      restaurantId: restaurant.id, branchId: main.id, tableId: tableAtMain.id,
      type: 'DINE_IN', channel: 'QR',
      customerName: entered.customerName,
      customerPhone: entered.customerPhone,
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      qrExperienceId: studentId,
      guestSessionId: `gs-${stamp}-1`,
    })
    const after = await prisma.customer.findUniqueOrThrow({ where: { id: entered.customerId! } })
    check('and the name is STILL theirs after the order', after.name === 'Jonathan Perera', after.name)
    check('the order found the same customer', order.customerId === entered.customerId)
    check('no customer was created by the order either', (await prisma.customer.count({ where: { restaurantId: restaurant.id } })) === before)

    // §15 — an ordinary TableFlow order that happens to remember where it came from.
    check('it is a QR order waiting for the till', order.channel === 'QR' && order.status === 'PENDING')
    check('and it records the code that produced it', order.qrExperienceId === studentId)
    check('a table was seated, by the ordinary rules', order.tableSessionId !== null)
  }

  console.log('\n── 7. VIP QR: a different category asks different things (§7, §28) ──')
  {
    const experience = (await getExperience({ restaurantId: restaurant.id, experienceId: studentId }))!
    await refuses('a VIP is asked for a company', () =>
      enterExperience({
        experience, fields: experience.fields, categoryId: vip.id,
        answers: { phone: '0770000001' },
      }), /QR_FIELD_REQUIRED/)

    const entered = await enterExperience({
      experience, fields: experience.fields, categoryId: vip.id,
      answers: { phone: '0770000001', company: 'Acme Ltd' },
    })
    const row = await prisma.customer.findUniqueOrThrow({ where: { id: entered.customerId! } })
    check('filed as VIP', row.categoryId === vip.id)
    check('with the company, and no campus ID', (row.profile as Record<string, { value: string }>).company?.value === 'Acme Ltd' && !('campus-id' in (row.profile as object)))

    // A blank phone is no record at all — the existing rule, not a new one.
    const anon = await enterExperience({
      experience,
      fields: experience.fields.filter((f) => f.key !== 'phone' || f.rule !== 'REQUIRED'),
      categoryId: null,
      answers: { name: 'Nobody' },
    })
    check('no phone means no customer record, never a shared one', anon.customerId === null)
  }

  console.log('\n── 8. OFFERS: the existing engine, one more check (§11, §12, §28) ──')
  {
    const coupon = await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id, code: `STUDENT${stamp.toUpperCase().slice(0, 4)}`,
        type: 'PERCENT', value: 1000, scope: 'BILL', isActive: true,
        qrExperienceId: studentId,
        segment: { categoryId: student.id },
      },
    })
    const lines = [{ foodId: rice.id, categoryId: lunch.id, quantity: 1, lineTotal: 50_000 }]
    const base = { restaurantId: restaurant.id, subtotal: 50_000, lines, branchId: main.id }

    const ok = await evaluate(coupon, { ...base, customerId: studentCustomerId, qrExperienceId: studentId })
    check('a student on the student QR gets it', ok.ok && ok.amount === 5_000, JSON.stringify(ok))

    const fromTill = await evaluate(coupon, { ...base, customerId: studentCustomerId, qrExperienceId: null })
    check('the same code typed at the till is REFUSED', !fromTill.ok, fromTill.reason)

    const wrongQr = await evaluate(coupon, { ...base, customerId: studentCustomerId, qrExperienceId: defaultId })
    check('and from another QR menu', !wrongQr.ok, wrongQr.reason)

    const vipCustomer = await prisma.customer.findFirstOrThrow({ where: { restaurantId: restaurant.id, categoryId: vip.id } })
    const wrongPerson = await evaluate(coupon, { ...base, customerId: vipCustomer.id, qrExperienceId: studentId })
    check('a VIP on the student QR does not get it', !wrongPerson.ok, wrongPerson.reason)

    const noone = await evaluate(coupon, { ...base, customerId: null, qrExperienceId: studentId })
    check('nor does somebody nobody identified', !noone.ok, noone.reason)

    // An unscoped coupon is untouched by any of this.
    const anywhere = await prisma.coupon.create({
      data: {
        restaurantId: restaurant.id, code: `ANY${stamp.toUpperCase().slice(0, 4)}`,
        type: 'FIXED', value: 1_000, scope: 'BILL', isActive: true,
      },
    })
    const a = await evaluate(anywhere, { ...base, customerId: null, qrExperienceId: null })
    const b = await evaluate(anywhere, { ...base, customerId: null, qrExperienceId: studentId })
    check('an ordinary coupon still works everywhere it did before', a.ok && b.ok)
  }

  console.log('\n── 9. LOYALTY: the existing balance, found by the canonical phone (§14, §28) ──')
  {
    await prisma.customer.update({ where: { id: studentCustomerId }, data: { loyaltyPoints: 250 } })
    const stored = (await prisma.customer.findUniqueOrThrow({ where: { id: studentCustomerId } })).phone
    check('the CRM keeps the number the way it was typed', stored === '077 123 4567', stored)

    const found = await balanceForPhone({ restaurantId: restaurant.id, phone: stored })
    check('the gate-created customer is found by their stored phone', found.customerId === studentCustomerId && found.points === 250)

    /*
     * And NOT by the digits alone — `balanceForPhone` matches the exact
     * string, as `quoteCart` and `placeOrder`'s upsert both do. That is a
     * pre-existing limit of the CRM, not something this feature introduced,
     * and it is precisely why the entry gate hands the cart the CANONICAL
     * stored phone rather than whatever the guest typed. Pinned so that if
     * somebody makes those lookups key-aware, this says where to look.
     */
    const missed = await balanceForPhone({ restaurantId: restaurant.id, phone: '0771234567' })
    check('the digits alone do not find them — which is why the gate echoes the stored value', missed.customerId === null)
  }

  console.log('\n── 10. BRANCH and TENANT isolation (§25, §28) ──')
  {
    const atBeach = await createExperience({
      restaurantId: restaurant.id, branchId: beach.id, name: 'Beach cards',
    })
    const mine = await listExperiences({ restaurantId: restaurant.id, branchIds: [main.id] })
    check('a Main-only list does not show the Beach code', !mine.some((row) => row.id === atBeach.id))
    check('and does show Main\'s', mine.some((row) => row.id === studentId))
    const everywhere = await listExperiences({ restaurantId: restaurant.id, branchIds: null })
    check('no branch filter shows them all', everywhere.length >= 4)
    check('nothing at all is an honest empty answer', (await listExperiences({ restaurantId: restaurant.id, branchIds: [] })).length === 0)

    const other = await prisma.restaurant.create({
      data: { name: `Rival ${stamp}`, slug: `rival-${stamp}`, email: `rival-${stamp}@test.local`, isActive: true },
    })
    otherId = other.id
    check('another restaurant cannot read this code by id', (await getExperience({ restaurantId: other.id, experienceId: studentId })) === null)
    check('nor list it', (await listExperiences({ restaurantId: other.id, branchIds: null })).length === 0)

    // The Beach code prices at the Beach — the same table number exists at both.
    const resolved = await resolveExperience(atBeach.publicId)
    check('a code names its own branch', resolved?.branch.code === 'BCH' && resolved.branchId === beach.id)
    check('and the table it would seat is that branch\'s', tableAtBeach.branchId === beach.id)
  }

  console.log('\n── 11. Regenerate and switch off keep the history (§17, §18, §28) ──')
  {
    const before = await prisma.qrExperience.findUniqueOrThrow({ where: { id: studentId } })
    const orders = await prisma.order.count({ where: { qrExperienceId: studentId } })

    const regenerated = await regeneratePublicId({ restaurantId: restaurant.id, experienceId: studentId })
    check('the printed code changes', regenerated.publicId !== before.publicId)
    check('the row does not', regenerated.id === before.id)
    check('the old code stops resolving', (await resolveExperience(before.publicId)) === null)
    check('and past orders still point at it', (await prisma.order.count({ where: { qrExperienceId: studentId } })) === orders)

    await setExperienceActive({ restaurantId: restaurant.id, experienceId: studentId, isActive: false })
    const off = await resolveExperience(regenerated.publicId)
    check('a switched-off code still resolves, so the screens can refuse it', off !== null && off.isActive === false)
    check('its orders survive', (await prisma.order.count({ where: { qrExperienceId: studentId } })) === orders)
    check('there is no delete anywhere in the feature',
      !readFileSync('src/features/qr/service.ts', 'utf8').includes('qrExperience.delete'))
    await setExperienceActive({ restaurantId: restaurant.id, experienceId: studentId, isActive: true })
  }

  console.log('\n── 12. The profile column is capped and merged (§25) ──')
  {
    const flood: Record<string, { label: string; value: string; at: string }> = {}
    for (let i = 0; i < 50; i += 1) {
      flood[`k${i}`] = { label: `L${i}`, value: 'x', at: new Date().toISOString() }
    }
    const capped = capProfile(null, flood)
    check('at most twenty answers are kept', Object.keys(capped).length === 20, String(Object.keys(capped).length))

    const long = capProfile(null, {
      big: { label: 'B'.repeat(500), value: 'v'.repeat(5_000), at: new Date().toISOString() },
    })
    check('a long value is truncated, not stored whole', long.big.value.length === 200 && long.big.label.length === 64)

    const first = capProfile(null, { a: { label: 'A', value: '1', at: 'x' } })
    const second = capProfile(first as never, { b: { label: 'B', value: '2', at: 'y' } })
    check('a second visit does not erase the first', second.a?.value === '1' && second.b?.value === '2')

    const overwritten = capProfile(second as never, { a: { label: 'A', value: '9', at: 'z' } })
    check('but an answer given again does replace itself', overwritten.a.value === '9')

    const junk = capProfile({ bad: 'not an answer', worse: [1, 2] } as never, { ok: { label: 'O', value: 'k', at: 't' } })
    check('malformed rows already in the column are dropped', !('bad' in junk) && !('worse' in junk) && junk.ok.value === 'k')

    const full = capProfile(capped as never, { late: { label: 'L', value: 'v', at: 't' } })
    check('and a new key cannot push past the cap', !('late' in full))
  }

  console.log('\n── 13. Opens are counted, orders are joined (§22) ──')
  {
    const code = (await prisma.qrExperience.findUniqueOrThrow({ where: { id: studentId } })).publicId
    await recordOpen(code)
    await recordOpen(code)
    const row = await prisma.qrExperience.findUniqueOrThrow({ where: { id: studentId } })
    check('opens are counted', row.openCount === 2 && row.lastOpenedAt !== null)

    const stats = await experienceStats({ restaurantId: restaurant.id, experienceId: studentId })
    check('orders and sales come from real orders', stats.orders === 1 && stats.sales > 0)
    check('customers too', stats.customers === 1)
    /*
     * Both people this code created: the student and the VIP. The regular who
     * already existed is not counted — they did not come from here.
     */
    check('and new customers from the source column', stats.newCustomers === 2, String(stats.newCustomers))
    check('categories are the CRM\'s own', stats.byCategory.some((row) => row.name === 'Student'))
    check('the top dish is a real order line', stats.topItems[0]?.name === 'Rice')

    await recordOpen('zzzzzzzzzz')
    check('an unknown code counts nothing', (await prisma.qrExperience.findUniqueOrThrow({ where: { id: studentId } })).openCount === 2)
  }

  console.log('\n── 14. A code with no table: delivery and takeaway (§3) ──')
  {
    const created = await createExperience({
      restaurantId: restaurant.id, branchId: main.id, name: 'Delivery leaflet',
    })
    check('a code asks for a table by default', created.askTable)

    await saveExperience({
      restaurantId: restaurant.id, experienceId: created.id,
      input: {
        name: 'Delivery leaflet', description: null, branchId: main.id,
        type: 'ORDERING', askTable: false,
        menuMode: 'ALL', menuCategoryIds: [], menuFoodIds: [],
        identifyCustomer: false, askCustomerCategory: false, customerCategoryIds: [],
        showSearch: true, showPrices: true, showOffers: true, showLoyalty: true, fields: [],
      },
    })
    const saved = (await getExperience({ restaurantId: restaurant.id, experienceId: created.id }))!
    check('the table question can be turned off', saved.askTable === false)
    check('and it still takes orders', saved.type === 'ORDERING')

    /*
     * The order such a code produces: a TAKEAWAY, filed against the code's own
     * branch, because there is no table to settle either.
     */
    const sessionsBefore = await prisma.tableSession.count({ where: { restaurantId: restaurant.id } })
    const order = await placeOrder({
      restaurantId: restaurant.id, branchId: main.id, tableId: null,
      type: 'TAKEAWAY', channel: 'QR',
      customerName: 'Doorstep', customerPhone: '0772223333',
      items: [{ foodId: rice.id, quantity: 1, optionIds: [] }],
      qrExperienceId: created.id,
      guestSessionId: `gs-${stamp}-delivery`,
    })
    check('the order is a takeaway with no table', order.type === 'TAKEAWAY' && order.tableId === null)
    check('filed against the code\'s branch', order.branchId === main.id)
    check('no table was seated', (await prisma.tableSession.count({ where: { restaurantId: restaurant.id } })) === sessionsBefore)
    check('and it still reaches the till like any QR order', order.channel === 'QR' && order.status === 'PENDING')
    check('carrying the code it came from', order.qrExperienceId === created.id)

    const schema = readFileSync('src/features/orders/schema.ts', 'utf8')
    check('the public schema allows a tableless order', schema.includes("tableId: z.string().cuid('Select a table').optional()"))
    const actions = readFileSync('src/features/orders/actions.ts', 'utf8')
    check('and the guest action makes it a takeaway', actions.includes("type: tableId ? 'DINE_IN' : 'TAKEAWAY'"))
    check('refusing when nothing names a branch either', actions.includes("'BRANCH_REQUIRED'"))
  }

  console.log('\n── 15. One welcome screen, every code (§13, §19) ──')
  {
    const defaults = readAppearance(null)
    check('an unset restaurant gets the shipped defaults', defaults.headingText === 'What is your table number?' && defaults.showLogo)
    check('and the menu defaults are what the app always showed', defaults.menuShowImages && defaults.menuShowPrices && defaults.menuLayout === 'LIST')

    const partial = readAppearance({ showLogo: false, headingText: 'Welcome to our table' })
    check('a stored value wins', partial.showLogo === false && partial.headingText === 'Welcome to our table')
    check('and everything unset still comes back whole', partial.showHours === true && partial.buttonText === 'Continue to the menu')

    const junk = readAppearance({ showLogo: 'yes', headingText: '   ', menuLayout: 'SPIRAL', accentColour: 'red' })
    check('a wrong type falls back rather than reaching a screen', junk.showLogo === true)
    check('a blank heading falls back — a guest must never read nothing', junk.headingText === 'What is your table number?')
    check('an unknown layout falls back', junk.menuLayout === 'LIST')
    check('and a colour that is not a colour falls back', junk.accentColour === '#f97316')

    /*
     * Every guest screen, not just the welcome one: the owner sets the menu,
     * the tracker, the bill and the wording around the questions in one place.
     */
    /*
     * Every guest screen the owner actually has: welcome, menu, checkout —
     * which is where a guest types their name and number, there being no
     * separate details page — and tracking.
     */
    check('the menu, the checkout and the tracker are all in the one setting',
      defaults.menuShowDietFilter && defaults.checkoutShowPhone && defaults.trackShowSteps)
    check('the checkout owns the name and number, because that is where they are asked',
      defaults.checkoutShowName && defaults.checkoutDetailsHeading === 'Your details')
    check('and each falls back on its own when the stored value is wrong',
      readAppearance({ trackShowSteps: 'yes', checkoutDetailsHeading: '  ' }).trackShowSteps === true
        && readAppearance({ checkoutDetailsHeading: '  ' }).checkoutDetailsHeading === 'Your details')

    /*
     * The BILL is deliberately absent: what it shows is `ReceiptFields` on
     * Printer & bill, read by the printed bill and the on-screen one alike.
     * Two forms deciding one thing is how they come to disagree.
     */
    check('the bill is not configured twice',
      !Object.keys(defaults).some((key) => key.startsWith('bill')))

    check('hex parses to the channels the screens use', JSON.stringify(hexToRgb('#f97316')) === JSON.stringify({ r: 249, g: 115, b: 22 }))
    check('and refuses anything else', hexToRgb('#fff') === null && hexToRgb('nonsense') === null)

    /*
     * A code narrows the restaurant's setting; it can never widen it. An owner
     * who hides prices everywhere should not have to hide them again per code.
     */
    const hidden = { ...defaults, menuShowPrices: false, menuShowSearch: false }
    const widened = narrowAppearance(hidden, { showPrices: true, showSearch: true })
    check('a code cannot turn back on what the restaurant turned off', !widened.menuShowPrices && !widened.menuShowSearch)
    const narrowed = narrowAppearance(defaults, { showPrices: false, showSearch: true })
    check('but it can hide something for itself', !narrowed.menuShowPrices && narrowed.menuShowSearch)
  }

  console.log('\n── 16. Nothing was duplicated (§26) ──')
  {
    const queries = readFileSync('src/features/qr/queries.ts', 'utf8')
    check('the menu comes from getPublicMenu', queries.includes('getPublicMenu(') && !queries.includes('prisma.food.findMany'))
    check('the categories come from the CRM', queries.includes('prisma.customerCategory.findMany'))

    const service = readFileSync('src/features/qr/service.ts', 'utf8')
    check('the customer comes from findOrCreateCustomer', service.includes('findOrCreateCustomer('))
    check('and this feature never writes a customer from scratch', !service.includes('prisma.customer.create'))
    check('nor an order', !service.includes('prisma.order.create'))

    const discounts = readFileSync('src/features/customers/discounts.ts', 'utf8')
    check('the offer check is one branch inside the existing engine', discounts.includes('if (coupon.qrExperienceId) {'))
    check('and refuses when the basket names no menu', discounts.includes("if (!context.qrExperienceId) return reject("))

    const cover = readFileSync('src/components/CoverPage.tsx', 'utf8')
    const entry = readFileSync('src/features/qr/components/qr-entry.tsx', 'utf8')
    check('both welcome screens render the SAME shell', cover.includes('<GuestCover') && entry.includes('<GuestCover'))
    check('so neither owns the layout any more', !cover.includes('guest-scrim fixed') && !entry.includes('guest-scrim fixed'))
    const shell = readFileSync('src/features/guest/components/guest-cover.tsx', 'utf8')
    check('the shell is what draws the card, the tiles and the footer',
      shell.includes('Powered by') && shell.includes('FeatureTile') && shell.includes('showFooter'))
    check('the table is the existing resolveTable', entry.includes('resolveTable({ tableNumber'))
    check('and the canonical name and phone are carried back', entry.includes('entered.data.customerName') && entry.includes('entered.data.customerPhone'))

    const cart = readFileSync('src/features/orders/components/cart-checkout.tsx', 'utf8')
    check('the cart places an ordinary guest order', cart.includes('placeGuestOrder({'))
    check('naming its tenant, so it works off /order', cart.includes('}, slug))'))

    const access = readFileSync('src/features/qr/access.ts', 'utf8')
    check('preview checks the tenant, not just that somebody is signed in', access.includes('user.restaurantId === params.experience.restaurantId'))

    // The owner's screens: one switcher, one setting, one place.
    const editor = readFileSync('src/features/settings/components/guest-appearance-editor.tsx', 'utf8')
    check('the editor switches between the guest screens that exist',
      ['front', 'menu', 'checkout', 'tracking'].every((key) => editor.includes(`'${key}'`)))
    check('and invents no page the guest app does not have', !editor.includes("'details'"))
    check('the bill points at Printer & bill rather than repeating it',
      editor.includes('/dashboard/settings?tab=printer'))
    check('and the welcome preview is still the real component', editor.includes('<GuestCover'))
    const settings = readFileSync('src/features/settings/components/settings-view.tsx', 'utf8')
    check('guest experience lives inside Settings, as a tab',
      settings.includes('<TabsTrigger value="guest">') && settings.includes('<GuestAppearanceEditor'))
    const moved = readFileSync('src/app/dashboard/settings/guest/page.tsx', 'utf8')
    check('and the old address still lands on it', moved.includes("permanentRedirect('/dashboard/settings?tab=guest')"))

    const middleware = readFileSync('src/middleware.ts', 'utf8')
    check('/m is not auth-gated', !middleware.includes("'/m'"))

    const lint = readFileSync('scripts/no-unscoped-branch-pages.ts', 'utf8')
    check('the new guest tree is inside the branch lint', lint.includes("pages(join(ROOT, 'm'), 'm')"))
    for (const page of ['page.tsx', 'menu/page.tsx', 'cart/page.tsx']) {
      const src = readFileSync(`src/app/m/[code]/${page}`, 'utf8')
      check(`/m/${page} re-resolves its branch`, src.includes('resolvePublicBranch('))
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`)
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    if (restaurantId) await cleanup(restaurantId).catch((error) => console.error('cleanup failed', error))
    if (otherId) await cleanup(otherId).catch((error) => console.error('cleanup failed', error))
    await prisma.$disconnect()
    process.exit(failed > 0 ? 1 : 0)
  })
