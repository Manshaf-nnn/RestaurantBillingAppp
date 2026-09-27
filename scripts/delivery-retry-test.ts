/**
 * The deadlock retry on the delivery handover.
 *
 * ── Why this injects instead of racing ──────────────────────────────────────
 *
 * A four-way race on one order already deadlocks in this system — a till
 * taking money, a second till taking money, a manager voiding a line, the
 * kitchen changing state — and handing a delivery over is a fifth actor on
 * that same row. Postgres resolves a deadlock correctly every time: it rolls
 * one transaction back whole, so the data is never wrong. What the loser gets
 * is `40P01`, and the person holding that error is a rider standing on
 * somebody's doorstep with the food in their hand.
 *
 * So the handover retries `40P01` a bounded number of times. That is control
 * flow, and it shipped with nothing exercising it — provoking a real deadlock
 * on demand is awkward enough that it is easier to ship the reasoning than the
 * proof. Injecting the error at the boundary tests the same four properties
 * without needing the race, and the one that matters most is the third: a
 * retry that fired on the WRONG errors would turn a single wrong PIN into
 * three attempts against the ten-guess cap that exists to stop precisely that.
 */
import { isDeadlock, withDeadlockRetry } from '../src/features/orders/delivery-handover'
import { prisma } from '../src/server/db/prisma'

let passed = 0
let failed = 0
function check(what: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${what}`) }
  else { failed += 1; console.log(`  ✗ ${what}${detail ? ` — ${detail}` : ''}`) }
}

/** What Postgres actually hands back, as far as this code is concerned. */
function deadlock(): Error & { code: string } {
  return Object.assign(new Error('deadlock detected'), { code: '40P01' })
}

async function main() {
  console.log('\n── Recognising the error ────────────────────────────────')
  check('a 40P01 is a deadlock', isDeadlock(deadlock()))
  check('a unique violation is not', !isDeadlock(Object.assign(new Error('dup'), { code: 'P2002' })))
  check('an ordinary Error is not', !isDeadlock(new Error('nope')))
  check('and neither is null', !isDeadlock(null))

  console.log('\n── It retries, and it stops ─────────────────────────────')
  let attempts = 0
  const eventually = await withDeadlockRetry(async () => {
    attempts += 1
    if (attempts < 3) throw deadlock()
    return 'done'
  })
  check('a deadlock is retried until it succeeds', eventually === 'done' && attempts === 3,
    `${attempts} attempts`)

  attempts = 0
  let gaveUp: unknown = null
  try {
    await withDeadlockRetry(async () => {
      attempts += 1
      throw deadlock()
    })
  } catch (error) {
    gaveUp = error
  }
  check('it gives up after three rather than looping', attempts === 3, `${attempts} attempts`)
  check('and rethrows the deadlock rather than swallowing it', isDeadlock(gaveUp))

  /*
   * The important one. A retry that fired on any error would take a wrong PIN
   * — which is a REFUSAL, not a failure — and try it twice more, burning three
   * of the ten guesses the order allows for one tap of the button.
   */
  console.log('\n── It retries a deadlock and nothing else ───────────────')
  attempts = 0
  let refusal: unknown = null
  try {
    await withDeadlockRetry(async () => {
      attempts += 1
      throw Object.assign(new Error('That PIN does not match'), { code: 'WRONG_PIN' })
    })
  } catch (error) {
    refusal = error
  }
  check('a wrong PIN is tried exactly once', attempts === 1, `${attempts} attempts`)
  check('and comes back as itself, not as a deadlock',
    (refusal as { code?: string })?.code === 'WRONG_PIN')

  attempts = 0
  try {
    await withDeadlockRetry(async () => {
      attempts += 1
      throw new Error('the database is gone')
    })
  } catch {
    /* expected */
  }
  check('nor is an ordinary failure retried', attempts === 1, `${attempts} attempts`)

  console.log('\n── A successful call is not retried ─────────────────────')
  attempts = 0
  const once = await withDeadlockRetry(async () => {
    attempts += 1
    return 42
  })
  check('the happy path runs exactly once', once === 42 && attempts === 1, `${attempts} attempts`)

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
  if (failed > 0) process.exitCode = 1
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
