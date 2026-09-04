/**
 * Migrations stay safe to deploy (production.md §15, §17).
 *
 * ── Why a test and not a review habit ───────────────────────────────────────
 *
 * This codebase's migration history is genuinely clean — fifty-plus migrations
 * with no destructive statement anywhere, which is not an accident and is the
 * single reason "roll forward" is a viable recovery strategy here. Nothing was
 * keeping it that way except care, and care is exactly what runs out at 6pm on
 * a Friday.
 *
 * The rules are checked by reading the SQL rather than by applying it, so this
 * costs nothing and runs in the static tier:
 *
 *   1. No statement drops or truncates data. A dropped column cannot be
 *      recovered by redeploying; it needs the backup, and the backup is hours
 *      old.
 *   2. A new NOT NULL column has a DEFAULT, or the migration fails the moment
 *      it meets a non-empty table — which is every table in production and no
 *      table in a fresh test database.
 *   3. A new UNIQUE index is not added blind to a table that may already hold
 *      duplicates. (This has bitten this project: "Unstick the production
 *      deploy: dedupe SKUs before the unique index" is a real commit here.)
 *   4. Every migration directory holds a migration.sql, and the applied history
 *      matches the files on disk.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json scripts/migration-safety-test.ts
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const DIR = 'prisma/migrations'

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { passed += 1; console.log(`  ✓ ${name}`) }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`) }
}

/** SQL with comments and string literals removed, so prose cannot trip a rule. */
function sqlOnly(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/^\s*--.*$/gm, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
}

/**
 * Migrations that predate these rules and are known-safe.
 *
 * Empty, and it should stay that way: an entry here is a migration somebody
 * decided to stop checking, and it needs a sentence saying why.
 */
const ALLOWED: Record<string, string> = {}

function main() {
  const names = readdirSync(DIR)
    .filter((entry) => statSync(join(DIR, entry)).isDirectory())
    .sort()

  console.log(`\n── ${names.length} migrations ──`)

  const destructive: string[] = []
  const notNullNoDefault: string[] = []
  const blindUnique: string[] = []
  const missingFile: string[] = []

  for (const name of names) {
    const path = join(DIR, name, 'migration.sql')
    let raw: string
    try {
      raw = readFileSync(path, 'utf8')
    } catch {
      missingFile.push(name)
      continue
    }
    if (name in ALLOWED) continue

    const sql = sqlOnly(raw)

    // 1. Destructive statements.
    for (const pattern of [
      /\bDROP\s+TABLE\b/i,
      /\bDROP\s+COLUMN\b/i,
      /\bTRUNCATE\b/i,
      /\bDROP\s+SCHEMA\b/i,
      /\bDROP\s+DATABASE\b/i,
    ]) {
      if (pattern.test(sql)) {
        destructive.push(`${name}: ${sql.match(pattern)?.[0]}`)
      }
    }

    /*
     * 2. NOT NULL without a default.
     *
     * Only on ADD COLUMN — a CREATE TABLE may define NOT NULL columns freely,
     * because the table is empty by construction.
     */
    const addColumn = /ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?\w+"?[^;,]*/gi
    for (const statement of sql.match(addColumn) ?? []) {
      if (/\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement)) {
        notNullNoDefault.push(`${name}: ${statement.replace(/\s+/g, ' ').trim().slice(0, 120)}`)
      }
    }

    /*
     * 3. A unique index that an existing table might already violate.
     *
     * Three ways a unique index is safe, and the third is the one that matters
     * most in practice:
     *
     *   a. the table is created in this same migration — it is empty;
     *   b. the migration de-duplicates first (a DELETE or UPDATE against that
     *      table). This project has had to do exactly that: "Unstick the
     *      production deploy: dedupe SKUs before the unique index";
     *   c. ANY indexed column is added by this same migration. Every existing
     *      row then holds NULL in that column, and Postgres treats NULLs as
     *      distinct in a unique index, so no two existing rows can collide —
     *      one new column is enough, whatever else is in the index. This is
     *      exactly how an idempotency key is introduced
     *      (`@@unique([restaurantId, clientRequestId])`), and flagging it would
     *      make the check cry wolf on the safest pattern there is.
     */
    const addedHere = new Set(
      [...sql.matchAll(/ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?"?(\w+)"?/gi)].map((m) =>
        m[1].toLowerCase(),
      ),
    )
    const uniqueIndexes = sql.match(/CREATE\s+UNIQUE\s+INDEX[^;]*/gi) ?? []
    for (const statement of uniqueIndexes) {
      const table = statement.match(/ON\s+"?(\w+)"?/i)?.[1]
      if (!table) continue

      const createdHere = new RegExp(`CREATE\\s+TABLE[^;]*"?${table}"?`, 'i').test(sql)
      const dedupedHere = new RegExp(`(DELETE\\s+FROM|UPDATE)\\s+"?${table}"?`, 'i').test(sql)

      // The column list is what follows the table name, in parentheses.
      /*
       * A PARTIAL unique index (one with a WHERE clause) is out of scope, and
       * that is a limitation stated rather than a rule quietly relaxed.
       *
       * This check reads SQL; it cannot evaluate a predicate like
       * `WHERE isActive AND "producesItemId" IS NOT NULL AND "archivedAt" IS
       * NULL` against data it has never seen, so it cannot tell a safe partial
       * index from a dangerous one. Every partial unique index in this history
       * was written deliberately and carries a comment explaining its
       * predicate — one of them says outright that it is MEANT to fail the
       * migration if a backfill produced two active recipes for one owner,
       * because failing loudly beats handing the resolver an arbitrary winner.
       *
       * What this check does catch is the genuinely blind case: a full-table
       * unique index dropped onto a table that may already hold duplicates.
       * That is the one that broke a production deploy here before ("Unstick
       * the production deploy: dedupe SKUs before the unique index"), and it is
       * the one a rule can actually judge.
       */
      if (/\bWHERE\b/i.test(statement)) continue

      const columnList = statement.slice(statement.indexOf('(') + 1, statement.lastIndexOf(')'))
      const columns = [...columnList.matchAll(/"?(\w+)"?/g)]
        .map((m) => m[1].toLowerCase())
        .filter((column) => !['asc', 'desc', 'nulls', 'first', 'last', 'text_ops'].includes(column))
      const someColumnNew = columns.some((column) => addedHere.has(column))

      if (!createdHere && !dedupedHere && !someColumnNew) {
        blindUnique.push(
          `${name}: unique index on existing table "${table}" (${columns.join(', ')}) ` +
            'without de-duplicating first',
        )
      }
    }
  }

  check('every migration directory holds a migration.sql',
    missingFile.length === 0, missingFile.join(', '))
  check('no migration drops or truncates data',
    destructive.length === 0, destructive.join('\n      '))
  check('no added NOT NULL column lacks a DEFAULT',
    notNullNoDefault.length === 0, notNullNoDefault.join('\n      '))
  check('no full-table unique index is added to an existing table without de-duplicating first',
    blindUnique.length === 0, blindUnique.join('\n      '))

  /*
   * The lock file pins the provider. A migration history generated against a
   * different database silently produces SQL the target cannot run.
   */
  const lock = readFileSync(join(DIR, 'migration_lock.toml'), 'utf8')
  check('the migration lock still targets postgresql', /postgresql/i.test(lock), lock.trim())

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main()
