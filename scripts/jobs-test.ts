/**
 * The background job queue (production.md §13).
 *
 * ── What is worth pinning ───────────────────────────────────────────────────
 *
 * The queue is new, and the two ways a queue quietly becomes useless are both
 * checked here: claiming that lets two runners take the same job, and a retry
 * policy that either gives up too early or hides failures by deleting them.
 *
 * The claim test runs two drains CONCURRENTLY, because that is what actually
 * happens — a run that takes longer than the schedule interval overlaps the
 * next one — and `FOR UPDATE SKIP LOCKED` is the whole reason it is safe.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/jobs-test.ts
 */
import { prisma } from '../src/server/db/prisma'
import { HANDLERS, enqueue, enqueueDailyWork, retryJob, runJobs } from '../src/server/jobs/runner'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`) }
}

async function main() {
  const stamp = Date.now().toString(36)
  await prisma.job.deleteMany({ where: { kind: { startsWith: `test-${stamp}` } } })

  console.log('\n── 1. A job runs, and says what it did ──')
  {
    let ran = 0
    HANDLERS[`test-${stamp}-ok`] = async () => {
      ran += 1
      return 'did the thing'
    }
    await enqueue({ kind: `test-${stamp}-ok` })
    const summary = await runJobs(10)
    check('the job was claimed and run', ran === 1 && summary.done >= 1, `ran ${ran}`)

    const row = await prisma.job.findFirstOrThrow({ where: { kind: `test-${stamp}-ok` } })
    check('it is DONE with its result recorded',
      row.status === 'DONE' && row.result === 'did the thing', `${row.status} ${row.result}`)
    check('and it recorded when it finished', row.finishedAt !== null)
  }

  console.log('\n── 2. Two runners never take the same job ──')
  {
    let ran = 0
    HANDLERS[`test-${stamp}-race`] = async () => {
      // Long enough that the second drain is genuinely inside the first.
      await new Promise((resolve) => setTimeout(resolve, 120))
      ran += 1
      return 'once'
    }
    for (let i = 0; i < 6; i += 1) await enqueue({ kind: `test-${stamp}-race` })

    // The shape a scheduler actually produces: an invocation overlapping the
    // previous one. FOR UPDATE SKIP LOCKED is what makes this safe.
    const [a, b] = await Promise.all([runJobs(10), runJobs(10)])
    check('every job ran exactly once across both runners', ran === 6, `${ran} runs`)
    check('…and the two runners split them, never doubling up',
      a.claimed + b.claimed === 6, `${a.claimed} + ${b.claimed}`)

    const rows = await prisma.job.findMany({ where: { kind: `test-${stamp}-race` } })
    check('all six are DONE', rows.every((row) => row.status === 'DONE'))
    check('and none was attempted twice', rows.every((row) => row.attempts === 1),
      rows.map((r) => r.attempts).join(','))
  }

  console.log('\n── 3. Failure backs off, then stops, and stays visible ──')
  {
    HANDLERS[`test-${stamp}-fail`] = async () => {
      throw new Error('the thing broke')
    }
    await enqueue({ kind: `test-${stamp}-fail`, maxAttempts: 2 })

    await runJobs(10)
    const first = await prisma.job.findFirstOrThrow({ where: { kind: `test-${stamp}-fail` } })
    check('a first failure goes back in the queue, not to FAILED',
      first.status === 'QUEUED' && first.attempts === 1, `${first.status} ${first.attempts}`)
    check('…with a later runAt, so it is not retried immediately',
      first.runAt.getTime() > Date.now(), first.runAt.toISOString())
    check('…and the reason is recorded', first.lastError?.includes('the thing broke') ?? false)

    // Bring it forward rather than waiting out the backoff.
    await prisma.job.update({ where: { id: first.id }, data: { runAt: new Date() } })
    await runJobs(10)
    const second = await prisma.job.findFirstOrThrow({ where: { id: first.id } })
    check('once attempts are exhausted it stops retrying',
      second.status === 'FAILED' && second.attempts === 2, `${second.status} ${second.attempts}`)

    /*
     * The point of the Job Center: a failure has to still be there. A queue
     * that sweeps away its own failures reports perfect health for ever.
     */
    await HANDLERS['job-trim']({ id: 'x', kind: 'job-trim', restaurantId: null, payload: null })
    const survived = await prisma.job.findUnique({ where: { id: first.id } })
    check('and the trim job never removes a FAILED row', survived !== null)

    console.log('\n── 4. Retry is safe and gives the full budget back ──')
    await retryJob(first.id)
    const retried = await prisma.job.findFirstOrThrow({ where: { id: first.id } })
    check('retry re-queues it with the attempt count reset',
      retried.status === 'QUEUED' && retried.attempts === 0, `${retried.status} ${retried.attempts}`)

    await prisma.job.deleteMany({ where: { kind: `test-${stamp}-fail` } })
  }

  console.log('\n── 5. A job kind with no handler fails loudly ──')
  {
    await enqueue({ kind: `test-${stamp}-missing`, maxAttempts: 1 })
    await runJobs(10)
    const row = await prisma.job.findFirstOrThrow({ where: { kind: `test-${stamp}-missing` } })
    check('it does not sit QUEUED for ever pretending it is about to happen',
      row.status === 'FAILED' && (row.lastError?.includes('No handler') ?? false),
      `${row.status} ${row.lastError}`)
    await prisma.job.deleteMany({ where: { kind: `test-${stamp}-missing` } })
  }

  console.log('\n── 6. The scheduler enqueues the day\'s work exactly once ──')
  {
    const day = new Date().toISOString().slice(0, 10)
    await prisma.job.deleteMany({ where: { dedupeKey: { endsWith: `:${day}` } } })

    const first = await enqueueDailyWork()
    const second = await enqueueDailyWork()
    check('the first call queues the day\'s work', first === 4, `${first}`)
    check('…and the 95 invocations after it queue nothing', second === 0, `${second}`)

    await prisma.job.deleteMany({ where: { dedupeKey: { endsWith: `:${day}` } } })
  }

  await prisma.job.deleteMany({ where: { kind: { startsWith: `test-${stamp}` } } })
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((error) => { console.error(error); process.exit(1) })
