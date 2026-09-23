/**
 * Where a QR experience lives, as a path (ar.md §17).
 *
 * `/m/<code>` — short enough to print under a QR image and to read aloud, and
 * deliberately its own tree rather than a variant of `/order/<slug>/<branch>`.
 * Two reasons:
 *
 *   - §2 and §29 insist the existing QR ordering flow keeps working exactly as
 *     it does. A separate tree makes that provable rather than argued: nothing
 *     under `/order` changes behaviour.
 *   - The code identifies the restaurant, the branch and the configuration all
 *     at once, so none of the three has to survive in a cookie. That is the
 *     bug `src/app/order/[slug]/[branch]/layout.tsx` was written to kill — a
 *     branch that lived in a cookie silently fell back to the default one, and
 *     guests browsed the wrong menu at the wrong prices.
 */

/** The single segment `/m` owns. Kept here so the route and the links agree. */
export const QR_ROOT = 'm'

/** `/m/<code>`, `/m/<code>/menu`, `/m/<code>/cart`. */
export function qrPath(code: string, ...rest: string[]): string {
  const tail = rest.length ? `/${rest.map(encodeURIComponent).join('/')}` : ''
  return `/${QR_ROOT}/${encodeURIComponent(code)}${tail}`
}
