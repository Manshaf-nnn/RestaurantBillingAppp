/**
 * Every screen says which location it is acting on (correctionA.md §6),
 * and a transfer always moves stock between two of them (§7).
 *
 * ── Why §6 needs a test at all ──────────────────────────────────────────────
 *
 * "Show the branch name" sounds like a thing you either did or did not do, and
 * so like a thing a test cannot usefully assert. The failure it guards is
 * narrower than that and much easier to reintroduce: the branch switcher in the
 * dashboard header *hides itself when there is nothing to pick*, which is
 * correct for the menu and wrong for the label. The person that leaves with no
 * location anywhere on screen is a manager pinned to one site — the one with
 * the least context and the most to lose by guessing which site they are
 * looking at. It is invisible in every multi-location test database, because
 * with two branches the switcher renders.
 *
 * So the first section builds exactly that account and asserts the resolver
 * still names their branch.
 *
 * ── And §7 ──────────────────────────────────────────────────────────────────
 *
 * Removing the storage pickers from the transfer form removed the only way to
 * express a same-branch move. The service still accepts storage ids —
 * historical rows carry them and `storage-stock-test` exercises them directly —
 * so the guarantee worth pinning is not "storage is gone" but "the form can no
 * longer construct the case the service refuses".
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/branch-context-test.ts
 */
import { readFileSync } from 'node:fs'

import { prisma } from '../src/server/db/prisma'
import { branchNameFor } from '../src/features/dashboard/selected-branch'

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
 * Source with its comments removed.
 *
 * Every "this used to do X" note in these files names the thing that was
 * removed — that is the whole point of writing them — so a grep over raw source
 * finds the explanation and reports the removal as incomplete. It did, on the
 * first run of this file. `migration-safety-test` has the same helper for the
 * same reason.
 */
function codeOnly(path: string): string {
  /*
   * Block comments and line comments, and deliberately nothing cleverer.
   *
   * The first attempt had a rule for `{/* … *\/}` ahead of this one, to strip
   * the braces of a JSX comment too. It was unsound: `\{\s*\/\*` also matches
   * an ordinary object literal whose first line is a comment, and the lazy
   * scan then ran to the next `*\/` followed by `}` — hundreds of lines later,
   * taking real code with it. Every board reported as not passing a prop it
   * plainly passed. Stripping the comment and leaving the empty braces behind
   * is enough for a grep, and cannot eat code.
   */
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*\/\/.*$/gm, ' ')
}

const stamp = Date.now().toString(36)

async function main() {
  const restaurant = await prisma.restaurant.create({
    data: { name: 'Branch Co', slug: `branch-${stamp}`, email: `bc-${stamp}@test.local` },
  })
  const other = await prisma.restaurant.create({
    data: { name: 'Other Co', slug: `otherb-${stamp}`, email: `ob-${stamp}@test.local` },
  })

  const kandy = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Kandy', code: 'KDY', isDefault: true },
  })
  const jaffna = await prisma.branch.create({
    data: { restaurantId: restaurant.id, name: 'Jaffna', code: 'JAF' },
  })
  const foreign = await prisma.branch.create({
    data: { restaurantId: other.id, name: 'Somebody Else', code: 'SE', isDefault: true },
  })

  console.log('\n── 1. A location can be named, and only within its own tenant ──')
  {
    check(
      'a branch resolves to its name',
      (await branchNameFor(restaurant.id, kandy.id)) === 'Kandy',
    )
    check(
      'a second one does too',
      (await branchNameFor(restaurant.id, jaffna.id)) === 'Jaffna',
    )

    /*
     * The id has already been through `selectedBranch` by the time a page calls
     * this, so this is the second lock on the same door — but it is the lock
     * that stops a station screen printing another restaurant's location name
     * across the top if the first one is ever loosened.
     */
    check(
      "another tenant's branch resolves to nothing",
      (await branchNameFor(restaurant.id, foreign.id)) === null,
    )
    check('an unknown id resolves to nothing', (await branchNameFor(restaurant.id, 'nope')) === null)
    check('null in, null out', (await branchNameFor(restaurant.id, null)) === null)

    // `scopeToOne` returns this for somebody confined to no branch at all.
    // There is no name for that, and it must not become a database lookup.
    check(
      'the "no branch" sentinel is not looked up',
      (await branchNameFor(restaurant.id, '__none__')) === null,
    )
  }

  console.log('\n── 2. The one-location case still has a label to show ──')
  {
    /*
     * A manager pinned to Kandy. `visibleBranchIds` gives them one branch, the
     * switcher has nothing to offer and renders no menu — and until §6 it
     * rendered nothing at all. What must survive is that their branch is still
     * nameable, because the static chip is built from exactly this call.
     */
    const confined = await prisma.user.create({
      data: {
        restaurantId: restaurant.id,
        email: `mgr-${stamp}@test.local`,
        name: 'Pinned manager',
        passwordHash: 'x',
        role: 'MANAGER',
        branchId: kandy.id,
      },
    })

    const { visibleBranchIds } = await import('../src/lib/rbac')
    const reach = visibleBranchIds({ role: confined.role, branchId: confined.branchId })
    check('a pinned manager reaches exactly one location', reach?.length === 1, String(reach))
    check(
      'and that location still has a name to put on screen',
      (await branchNameFor(restaurant.id, reach![0])) === 'Kandy',
    )
  }

  console.log('\n── 3. The station shells accept a branch (§6) ──')
  {
    /*
     * Read rather than rendered: these are client components inside a React
     * tree this repo has no renderer for, and the thing worth pinning is that
     * the prop was threaded all the way from the page to the shell — which is
     * the step that gets dropped when one of these boards is next refactored.
     */
    const shell = codeOnly('src/components/ops-shell.tsx')
    check('OpsShell takes a branch', /branch\?:\s*string \| null/.test(shell))
    check('and renders it', /\{branch \?/.test(shell))

    for (const [label, board, page] of [
      ['kitchen', 'src/features/kitchen/components/kitchen-board.tsx', 'src/app/kitchen/page.tsx'],
      ['waiter', 'src/features/waiter/components/waiter-board.tsx', 'src/app/waiter/page.tsx'],
      ['cashier', 'src/features/cashier/components/cashier-board.tsx', 'src/app/cashier/page.tsx'],
    ] as const) {
      check(`the ${label} board passes it to the shell`, /branch=\{branchName\}/.test(codeOnly(board)))
      check(`the ${label} page resolves it`, /branchNameFor\(/.test(codeOnly(page)))
    }
  }

  console.log('\n── 4. A transfer moves between two locations (§7) ──')
  {
    const builder = codeOnly('src/features/transfers/components/transfer-builder.tsx')

    check('the form no longer asks for a storage area', !/storage area/i.test(builder))
    check('and no longer sends storage ids', !/fromStorageId|toStorageId/.test(builder))
    /*
     * DELIBERATE behaviour change, recorrection.md §1, 2026-09: transfers are
     * pulled. The requester's own branch is the destination, chosen first (or
     * locked, when they have one), and the SOURCE list is every other
     * location. So it is the source list that excludes the destination now —
     * the same rule, that a transfer changes which location holds the stock,
     * read from the other end.
     */
    check(
      'the source list excludes the destination',
      /locations\.filter\(\(l\) => l\.id !== toId\)/.test(builder),
    )
    check('and a same-location transfer is refused outright', /fromId === toId/.test(builder))

    /*
     * The other half, and the reason this is not simply a deletion: the service
     * still supports shelf-to-shelf. Historical transfers reference those
     * columns and `storage-stock-test` calls the service with them, so a
     * "cleanup" that removed the parameters would break both.
     */
    const service = codeOnly('src/features/transfers/service.ts')
    check('the service still accepts storage ids for existing rows', /fromStorageId/.test(service))

    const columns: Array<{ column_name: string }> = await prisma.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'stock_transfers' AND column_name IN ('fromStorageId','toStorageId')`,
    )
    check('and the columns are still on the table', columns.length === 2, `${columns.length}`)
  }

  console.log('\n── 5. Stock is not added from a location page (§5) ──')
  {
    let gone = false
    try {
      readFileSync('src/features/branches/components/add-stock-form.tsx', 'utf8')
    } catch {
      gone = true
    }
    check('the Add stock form is gone', gone)

    const storageForm = codeOnly('src/features/branches/components/storage-form.tsx')
    check(
      'and nothing still points people at it',
      !/Add stock here/.test(storageForm),
      'storage-form.tsx still names a button that no longer exists',
    )
  }

  await prisma.restaurant.delete({ where: { id: restaurant.id } })
  await prisma.restaurant.delete({ where: { id: other.id } })
}

main()
  .catch((error) => {
    console.error(error)
    failed += 1
  })
  .finally(async () => {
    await prisma.$disconnect()
    console.log(`\n${passed} passed, ${failed} failed`)
    process.exit(failed > 0 ? 1 : 0)
  })
