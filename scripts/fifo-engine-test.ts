/**
 * The FIFO walk itself: the spec's worked example, and exactness.
 *
 * ── Why this is its own suite ──────────────────────────────────────────────
 *
 * FIFO.md sets out an exact sequence and says "TEST THE EXACT FLOW". Section 1
 * is that sequence, number for number. Everything else in the system is built
 * on this walk, so if it is wrong nothing above it can be right.
 *
 * Section 2 is the part that cannot be checked by inspection. A layer carries
 * an integer value and quantities are fractional, so every partial draw rounds.
 * The rule that makes it exact is that the draw which EMPTIES a layer takes
 * whatever value is left in it — collecting whatever the earlier draws rounded
 * away. That is asserted here over ten thousand randomised layers, because a
 * property like "the books always tie" is not something three hand-written
 * cases can establish.
 *
 * Pure arithmetic: no database, runs in milliseconds.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/fifo-engine-test.ts
 */
import { layersValue, nextUnitCost, walkFifo, type FifoLot } from '../src/features/inventory/fifo-walk'

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

/** A layer, described the way FIFO.md describes one: so much at such a price. */
const lot = (id: string, qty: number, price: number): FifoLot => ({
  batchId: id,
  batchNo: id,
  remaining: qty,
  remainingValue: Math.round(qty * price),
  unitCost: price,
})

/** Apply a draw to a set of layers, the way the allocator will. */
function apply(lots: FifoLot[], draw: ReturnType<typeof walkFifo>): FifoLot[] {
  const byId = new Map(draw.lots.map((l) => [l.batchId, l]))
  return lots.map((l) => {
    const taken = byId.get(l.batchId)
    if (!taken) return l
    return {
      ...l,
      remaining: Math.round((l.remaining - taken.quantity) * 1e6) / 1e6,
      remainingValue: l.remainingValue - taken.lineValue,
    }
  })
}

const live = (lots: FifoLot[]) =>
  lots.filter((l) => l.remaining > 1e-9).map((l) => `${l.remaining}@${l.unitCost}`).join(' + ')

/* ── 1. FIFO.md's worked example, exactly ─────────────────────────────────── */
console.log('\n1. The spec’s own sequence (FIFO.md lines 91-100)')
{
  let shelf = [lot('A', 50, 100), lot('B', 20, 150)]

  check('70 units on the shelf', shelf.reduce((s, l) => s + l.remaining, 0) === 70)
  check('worth 8,000', layersValue(shelf) === 8000, String(layersValue(shelf)))
  check('next cost is 100 — the oldest layer, not a blend', nextUnitCost(shelf) === 100)

  const steps: Array<[number, string, number]> = [
    [10, '40@100 + 20@150', 1000],
    [35, '5@100 + 20@150', 3500],
    [5, '20@150', 500],
    [10, '10@150', 1500],
  ]
  let spent = 0
  for (const [want, expected, cost] of steps) {
    const draw = walkFifo({ lots: shelf, quantity: want })
    spent += draw.totalValue
    shelf = apply(shelf, draw)
    check(`consume ${want} costs ${cost}`, draw.totalValue === cost, String(draw.totalValue))
    check(`  leaves ${expected}`, live(shelf) === expected, live(shelf))
  }

  check('60 units consumed for 6,500', spent === 6500, String(spent))
  check('1,500 left on the shelf', layersValue(shelf) === 1500, String(layersValue(shelf)))
  check(
    'and 8,000 − 6,500 = 1,500 — the books tie',
    8000 - spent === layersValue(shelf),
  )
  check('next cost is now 150 — the first layer is spent', nextUnitCost(shelf) === 150)
}

/* ── 2. Exactness ─────────────────────────────────────────────────────────── */
console.log('\n2. A layer issues out exactly what it took in')
{
  // The case that motivated the whole design: a cost below one minor unit.
  const cheap = [lot('X', 1000, 0)]
  cheap[0].remainingValue = 650 // 650 paid for 1,000 g — 0.65 a gram
  const first = walkFifo({ lots: cheap, quantity: 400 })
  const rest = apply(cheap, first)
  const second = walkFifo({ lots: rest, quantity: 600 })
  check(
    '650 paid for 1,000 g issues out as exactly 650',
    first.totalValue + second.totalValue === 650,
    `${first.totalValue} + ${second.totalValue}`,
  )
  check('and the layer is empty afterwards', apply(rest, second)[0].remainingValue === 0)

  // A price that does not divide: 1,000 over 3.
  let thirds = [lot('Y', 3, 0)]
  thirds[0].remainingValue = 1000
  let got = 0
  for (let i = 0; i < 3; i += 1) {
    const draw = walkFifo({ lots: thirds, quantity: 1 })
    got += draw.totalValue
    thirds = apply(thirds, draw)
  }
  check('1,000 over 3 units issues out as 1,000, not 999', got === 1000, String(got))

  // The property, over randomised layers.
  let worst = 0
  let worstCase = ''
  const rand = (() => {
    let seed = 20260929
    return () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
  })()

  for (let run = 0; run < 10_000; run += 1) {
    const qty = Math.round((0.1 + rand() * 500) * 1000) / 1000
    const paid = 1 + Math.floor(rand() * 500_00)
    let layers: FifoLot[] = [{ batchId: 'R', batchNo: 'R', remaining: qty, remainingValue: paid, unitCost: Math.round(paid / qty) }]
    let issued = 0
    let guard = 0
    while (layers[0].remaining > 1e-9 && guard < 500) {
      guard += 1
      const want = Math.min(layers[0].remaining, Math.round((0.01 + rand() * (qty / 2)) * 1000) / 1000)
      const draw = walkFifo({ lots: layers, quantity: want })
      issued += draw.totalValue
      layers = apply(layers, draw)
    }
    const drift = Math.abs(issued + layers[0].remainingValue - paid)
    if (drift > worst) {
      worst = drift
      worstCase = `${paid} over ${qty}`
    }
  }
  check(
    '10,000 randomised layers, drawn down in random pieces: no drift',
    worst === 0,
    worst > 0 ? `worst ${worst} (${worstCase})` : '',
  )
}

/* ── 3. Shortfall is reported, never priced ───────────────────────────────── */
console.log('\n3. Stock that is not there has no cost')
{
  const shelf = [lot('A', 5, 200)]
  const draw = walkFifo({ lots: shelf, quantity: 8 })
  check('it draws what is there', draw.lots.length === 1 && draw.lots[0].quantity === 5)
  check('worth exactly what that layer held', draw.totalValue === 1000, String(draw.totalValue))
  check('and reports the 3 it could not cover', draw.shortfall === 3, String(draw.shortfall))
  check(
    'the uncovered part is worth nothing — no invented cost',
    draw.totalValue === 1000,
    'FIFO.md: "do not invent a fake FIFO cost"',
  )

  const empty = walkFifo({ lots: [], quantity: 5 })
  check('an empty shelf draws nothing and costs nothing', empty.totalValue === 0 && empty.shortfall === 5)
  check('and reports no per-unit cost rather than guessing one', empty.unitCost === 0)
}

/* ── 4. Order, and crossing layers ────────────────────────────────────────── */
console.log('\n4. Oldest first, across as many layers as it takes')
{
  const shelf = [lot('A', 5, 1200), lot('B', 20, 1280), lot('C', 10, 1500)]
  const draw = walkFifo({ lots: shelf, quantity: 30 })
  check('three layers drawn, in order', draw.lots.map((l) => l.batchNo).join(',') === 'A,B,C')
  check('the oldest is exhausted first', draw.lots[0].quantity === 5 && draw.lots[1].quantity === 20)
  check('and the newest covers the rest', draw.lots[2].quantity === 5)
  check(
    'valued layer by layer, not at a blend',
    draw.totalValue === 5 * 1200 + 20 * 1280 + 5 * 1500,
    String(draw.totalValue),
  )
  check(
    'the lines sum to the total, exactly',
    draw.lots.reduce((s, l) => s + l.lineValue, 0) === draw.totalValue,
  )
  check('a spent layer is skipped, not re-offered', walkFifo({ lots: [lot('A', 0, 100), lot('B', 4, 250)], quantity: 2 }).lots[0].batchNo === 'B')
}

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`)
process.exitCode = failed > 0 ? 1 : 0
