/**
 * The transfer report reads what the screen reads, and no more.
 *
 * ── Why this is a source-level test ────────────────────────────────────────
 *
 * The bug it exists to stop was not a type error and would not have failed a
 * render test. The transfers export narrowed with `scopeToOne(selection)`,
 * which returns **null** whenever the viewer can reach more than one branch and
 * has not picked one — and the query it was handed to applied no branch
 * predicate for a null branch. So a manager confined to two of five locations
 * downloaded every transfer in the restaurant, from the button directly above a
 * screen that correctly showed only theirs. Everything compiled. The file
 * looked right.
 *
 * A branch-isolation failure is only visible as "these two functions were
 * called with the wrong argument", so that is what is asserted, by reading the
 * source — the same technique `approval-desk-test.ts` uses on the decision
 * permission map. Section 3 covers the other half: that the report page, the
 * print page and the export all go through ONE where-builder, because three
 * hand-built predicates is how the file came to disagree with the screen.
 *
 * Usage:
 *   npx tsx --tsconfig tsconfig.test.json scripts/transfer-report-test.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..')
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8')

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

/**
 * Comments out, so a note EXPLAINING the old mistake is not read as the
 * mistake. The code is what is being asserted about.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
}

/** The body of one `if (type === '<name>')` branch in the export route. */
function exportBranch(source: string, type: string): string {
  const start = source.indexOf(`if (type === '${type}')`)
  if (start === -1) return ''
  // Up to the next top-level branch, which is enough to isolate one type.
  const rest = source.slice(start + 1)
  const next = rest.indexOf("\n    if (type === '")
  return next === -1 ? rest : rest.slice(0, next)
}

console.log('\nTransfer report\n')

const route = read('src/app/api/reports/export/route.ts')
const queries = read('src/features/transfers/queries.ts')
const reportPage = read('src/app/dashboard/transfers/report/page.tsx')
const printPage = read('src/app/dashboard/transfers/[transferId]/print/page.tsx')
const boardPage = read('src/app/dashboard/transfers/page.tsx')

/* ── 1. The export is scoped to the viewer's whole reach ──────────────────── */
console.log('1. Branch isolation on the export')

const transfersBranch = exportBranch(route, 'transfers')
check('the export route has a transfers branch', transfersBranch.length > 0)
check(
  'it narrows by branchIds, the viewer’s whole reach',
  /branchIds,/.test(transfersBranch),
  'Expected `branchIds` to be passed into the query.',
)
check(
  'it never narrows by scopeToOne — null means "no filter at all"',
  !/scopeToOne\(/.test(code(transfersBranch)),
  'scopeToOne returns null for a viewer who reaches several branches and has picked none.',
)
check(
  'it exports LINES, not transfer headers',
  transfersBranch.includes('listTransferLines('),
  'A header-only export cannot say what moved or who signed for it.',
)
check(
  'the header-only listTransfers is no longer imported by the route',
  !/import \{[^}]*\blistTransfers\b/.test(route),
)

/*
 * The sibling leak, in the same file: the variance export narrowed the same
 * wrong way. Pinned here rather than in a new file because it is the same
 * mistake and would be made again in the same place.
 */
const varianceBranch = exportBranch(route, 'variance')
check(
  'the variance export is also capped by the viewer’s reach',
  varianceBranch.includes('branchIds'),
  'scopeToOne alone is null for a confined manager who can see several locations.',
)

/* ── 2. Every screen asks the same permission ─────────────────────────────── */
console.log('\n2. Permissions')

check(
  'the export branch requires TRANSFER_VIEW',
  transfersBranch.includes('PERMISSIONS.TRANSFER_VIEW'),
  'REPORT_EXPORT alone would make the download a way round the screen’s gate.',
)
check('the report page requires TRANSFER_VIEW', reportPage.includes('PERMISSIONS.TRANSFER_VIEW'))
check('the print page requires TRANSFER_VIEW', printPage.includes('PERMISSIONS.TRANSFER_VIEW'))
check(
  'the print page re-applies assertTransferSide',
  printPage.includes('assertTransferSide('),
  'A printable version must not answer what the detail page refuses.',
)

/* ── 3. One where-builder, so the three can never disagree ────────────────── */
console.log('\n3. One query behind screen, paper and file')

check(
  'transferBoardWhere is exported',
  /export function transferBoardWhere\(/.test(queries),
)
check(
  'getTransferBoard builds its predicate with it',
  /getTransferBoard[\s\S]*?transferBoardWhere\(/.test(queries),
)
check(
  'listTransferLines builds its predicate with it',
  /listTransferLines[\s\S]*?transferBoardWhere\(/.test(queries),
)
check(
  'listTransferLines takes branchIds, never a single branchId',
  /export async function listTransferLines\(params: \{[\s\S]*?branchIds: string\[\] \| null/.test(queries),
)

/* ── 4. The report carries the screen's filters ───────────────────────────── */
console.log('\n4. The filters travel')

for (const key of ['search', 'fromBranch', 'toBranch', 'status', 'item']) {
  check(
    `the export reads ?${key}, the same name the board puts in the URL`,
    transfersBranch.includes(`'${key}'`),
    'A parameter name that does not match is a filter silently dropped from the file.',
  )
}
check(
  'the export applies no default period — the board has none',
  transfersBranch.includes('rangeRequested'),
  'Defaulting to a week would hand somebody a file quietly missing older transfers.',
)
check(
  'the board links to the report and no longer offers a header-only export',
  boardPage.includes('/dashboard/transfers/report') && !boardPage.includes('<ExportMenu'),
)

/* ── 5. The paper says what the screen could not ──────────────────────────── */
console.log('\n5. What the document has to carry')

check(
  'getTransferDetail returns the reject reason',
  /getTransferDetail[\s\S]*?rejectReason: t\.rejectReason/.test(queries),
  'It was stored from the first version and never read back: rejected, but never why.',
)
check(
  'and the per-line variance note, unit cost and value',
  /varianceNote: l\.varianceNote/.test(queries) &&
    /unitCost: l\.unitCost/.test(queries) &&
    /lineValue:/.test(queries),
)
for (const [what, needle] of [
  ['the reject reason', 'rejectReason'],
  ['both signature blocks', 'Signature'],
  ['who dispatched it', 'Dispatched by'],
  ['who received it', 'Received by'],
] as const) {
  check(`the print page shows ${what}`, printPage.includes(needle))
}
check(
  'the print page is wrapped in .print-sheet and its chrome is .no-print',
  printPage.includes('print-sheet') && printPage.includes('no-print'),
)

console.log(`\n  ${passed} passed, ${failed} failed\n`)
process.exitCode = failed > 0 ? 1 : 0
