/**
 * Did this HTML response carry a server-component error that never reached the
 * status code?
 *
 * ── Why a 200 is not proof a page rendered ──────────────────────────────────
 *
 * A `force-dynamic` App Router page streams. Next sends the shell — html, head,
 * the dashboard chrome, the sidebar — and flushes it before the page's own
 * data has resolved. Once those bytes are out the status line is already 200
 * and cannot be taken back. If a loader throws AFTER that, the error is
 * delivered as a later chunk in the same 200 response: React appends an RSC
 * error record and a small runtime that swaps the nearest error boundary in on
 * the client.
 *
 * So the person sees "This page could not load" while `fetch()` sees a 200
 * with a large, healthy-looking body — and the boundary's own text is nowhere
 * in the HTML, because it is rendered by the browser afterwards, not by the
 * server.
 *
 * That is not hypothetical. `page-render-test` swept 130 page-loads green,
 * twice over, while the Purchasing report threw for every tenant that picked
 * a location: the shell flushed, the throw landed in a later chunk, and the
 * check looked only at the status and the boundary's words. Nothing in the
 * suite could see it. The bug was found in `error_logs`, days later.
 *
 * ── What it looks for ───────────────────────────────────────────────────────
 *
 * Two signals, both emitted only when a stream actually failed:
 *
 *   `<id>:E{"digest":"<hash>"}`  the RSC error record. The digest is the hash
 *                               Next logs alongside the real stack. A digest
 *                               of `$undefined` is ordinary metadata on a
 *                               healthy page and is NOT this.
 *   `$RX=function`              React's reject-boundary helper, injected into
 *                               the stream only to trigger a boundary.
 *
 * Both survive minification because they are protocol, not application code.
 */

/**
 * Digests that are control flow, not failure.
 *
 * `redirect()` and `notFound()` are implemented by THROWING, so a page that
 * redirects mid-render produces the same error record as a page that broke —
 * and the digest is the only thing that tells them apart. Next spells them
 * out rather than hashing them, which is what makes this check possible:
 * `NEXT_REDIRECT;replace;/dashboard/payment-details;308;`.
 *
 * Two real pages redirect this way (`/dashboard/online-payments` and
 * `/dashboard/settings/guest`, both of which moved), and reading them as
 * broken would be how this whole check gets switched off for crying wolf.
 */
const CONTROL_FLOW = /^(NEXT_REDIRECT|NEXT_NOT_FOUND|DYNAMIC_SERVER_USAGE)/

/** The error's digest if the stream failed, otherwise null. */
export function streamedServerError(html: string): string | null {
  /*
   * Every error record, not just the first. A page can redirect one segment
   * and throw in another, and taking the first digest would report the
   * redirect and call the throw clean.
   *
   * The RSC payload is embedded inside a JS string literal, so its quotes are
   * backslash-escaped; both shapes are accepted rather than guessed at.
   */
  const digests = [
    ...html.matchAll(/\d+:E\{\\"digest\\":\\"([^"\\]+)/g),
    ...html.matchAll(/\d+:E\{"digest":"([^"]+)/g),
  ].map((match) => match[1])

  const real = digests.find((digest) => digest !== '$undefined' && !CONTROL_FLOW.test(digest))
  if (real) return real

  /*
   * A boundary was rejected even if the digest shape changes between Next
   * versions. Checked only when no error record was found at all, so a
   * redirect — which ships this helper too — is not caught by it.
   */
  if (digests.length === 0 && /\$RX\s*=\s*function/.test(html)) {
    return 'unknown (boundary rejected mid-stream)'
  }

  return null
}

/** The error boundary's own words, for the non-streamed case. */
export const BOUNDARY_TEXT = ['This page could not load', 'Something went wrong', 'Application error']

/**
 * Everything wrong with one HTML response, or null if it rendered.
 *
 * Callers should treat this as the single answer to "did this page work",
 * rather than checking the status alone.
 */
export function renderFailure(status: number, html: string): string | null {
  if (status !== 200) return `HTTP ${status}`
  const boundary = BOUNDARY_TEXT.find((needle) => html.includes(needle))
  if (boundary) return `rendered "${boundary}"`
  const digest = streamedServerError(html)
  if (digest) {
    return (
      `streamed a server-component error after the shell flushed ` +
      `(digest ${digest}) — the response is 200 but the person sees the error boundary`
    )
  }
  return null
}
