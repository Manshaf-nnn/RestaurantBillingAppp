/**
 * Daily database backup.
 *
 *   npm run db:backup
 *
 * Runs `pg_dump` against DATABASE_URL, gzip-compresses the output into
 * BACKUP_DIR, and prunes dumps older than BACKUP_RETENTION_DAYS. Intended to be
 * driven by cron or a scheduled container.
 */
import { execFile } from 'node:child_process'
import { createGzip } from 'node:zlib'
import { createWriteStream } from 'node:fs'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

async function main() {
  const databaseUrl = process.env.DATABASE_URL
  if (!databaseUrl) throw new Error('DATABASE_URL is required')

  const backupDir = resolve(process.env.BACKUP_DIR || './backups')
  const retentionDays = Number(process.env.BACKUP_RETENTION_DAYS || 14)

  await mkdir(backupDir, { recursive: true })

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outfile = join(backupDir, `restaurantos-${stamp}.sql.gz`)

  console.log(`[backup] dumping database → ${outfile}`)

  // Stream pg_dump through gzip to keep memory flat on large databases.
  const child = execFile('pg_dump', ['--no-owner', '--no-privileges', databaseUrl])
  if (!child.stdout) throw new Error('pg_dump produced no output stream')

  await new Promise<void>((resolvePromise, rejectPromise) => {
    const gzip = createGzip()
    const out = createWriteStream(outfile)
    child.stdout!.pipe(gzip).pipe(out)
    child.on('error', rejectPromise)
    child.stderr?.on('data', (data) => process.stderr.write(data))
    out.on('finish', resolvePromise)
    out.on('error', rejectPromise)
  })

  const info = await stat(outfile)
  console.log(`[backup] wrote ${(info.size / 1024).toFixed(1)} KB`)

  // Prune old backups.
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000
  const files = await readdir(backupDir)
  let pruned = 0
  for (const file of files) {
    if (!file.startsWith('restaurantos-') || !file.endsWith('.sql.gz')) continue
    const path = join(backupDir, file)
    const fileInfo = await stat(path)
    if (fileInfo.mtimeMs < cutoff) {
      await unlink(path)
      pruned += 1
    }
  }
  if (pruned) console.log(`[backup] pruned ${pruned} backup(s) older than ${retentionDays} days`)

  console.log('[backup] done')
}

main().catch((error) => {
  console.error('[backup] failed:', error.message)
  process.exit(1)
})
