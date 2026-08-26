/**
 * Which build is actually running.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * A fix was pushed to GitHub, the commit was there, and the live site did not
 * change — with nothing anywhere to say whether the deploy had run, failed, or
 * never started. The only way to tell was to hunt for a visual difference,
 * which is guesswork and gets it wrong when a change is subtle.
 *
 * `/api/health` reported `version: '1.0.0'`, a hardcoded string that has never
 * once been true. It now reports the commit the running code was built from,
 * so "did my fix reach the site" is a question with an answer:
 *
 *   curl -s https://your-site/api/health | grep commit
 *
 * Compare it with `git rev-parse --short HEAD`. Same → the fix is live.
 * Different → the deploy did not happen, whatever the host's dashboard says.
 *
 * ── Where the values come from ──────────────────────────────────────────────
 *
 * Every host injects the commit under its own name, and none of them is
 * present locally. All three are read rather than one, so this keeps working
 * if the site moves between them — which matters here, because the repo
 * carries config for two.
 */

function firstOf(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    if (value && value.trim()) return value.trim()
  }
  return null
}

/** The commit this build came from, short form. `null` when running locally. */
export function buildCommit(): string | null {
  /*
   * Stamped by `next.config.mjs`, not read from the environment here.
   *
   * These variables exist only while the site is BEING built. A serverless
   * function that starts three days later has none of them, so reading them at
   * runtime returned null on every real deploy — this endpoint reported
   * `commit: null` on a live site, which is the one answer it must never give.
   * The build bakes the value in, exactly as it already did for the timestamp.
   */
  const full = firstOf(
    process.env.NEXT_PUBLIC_BUILD_COMMIT,
    // Kept as a fallback for a host that does surface them at runtime.
    process.env.COMMIT_REF, // Netlify
    process.env.RENDER_GIT_COMMIT, // Render
    process.env.VERCEL_GIT_COMMIT_SHA, // Vercel
    process.env.SOURCE_VERSION, // Heroku
    process.env.GIT_COMMIT,
  )
  return full ? full.slice(0, 7) : null
}

/** The branch it was built from, when the host says. */
export function buildBranch(): string | null {
  return firstOf(
    process.env.NEXT_PUBLIC_BUILD_BRANCH,
    process.env.BRANCH,
    process.env.RENDER_GIT_BRANCH,
    process.env.VERCEL_GIT_COMMIT_REF,
  )
}

/**
 * When this build was made.
 *
 * Stamped at build time by `next.config`, because nothing at runtime knows —
 * a serverless function starting up tells you when it woke, not when the code
 * was compiled, and the two can be weeks apart.
 */
export function buildTime(): string | null {
  return firstOf(process.env.NEXT_PUBLIC_BUILD_TIME)
}

export interface BuildInfo {
  commit: string | null
  branch: string | null
  builtAt: string | null
  /** True when this is a local `next dev` / `next start`, not a deploy. */
  local: boolean
}

export function buildInfo(): BuildInfo {
  const commit = buildCommit()
  return {
    commit,
    branch: buildBranch(),
    builtAt: buildTime(),
    local: commit === null,
  }
}
